import type { Database } from '../app/database/database.types';
import type { Config } from '../config/config.types';
import type { Logger } from '../shared/logger/logger';
import type { Document } from './documents.types';
import { safely } from '@corentinth/chisels';
import { extractTextFromFile } from '@papra/lecture';
import pLimit from 'p-limit';
import { checkIfOrganizationCanCreateNewDocument } from '../organizations/organizations.usecases';
import { createPlansRepository, type PlansRepository } from '../plans/plans.repository';
import { createLogger } from '../shared/logger/logger';
import { createSubscriptionsRepository, type SubscriptionsRepository } from '../subscriptions/subscriptions.repository';
import { createTaggingRulesRepository, type TaggingRulesRepository } from '../tagging-rules/tagging-rules.repository';
import { applyTaggingRules } from '../tagging-rules/tagging-rules.usecases';
import { createTagsRepository, type TagsRepository } from '../tags/tags.repository';
import { createTrackingServices, type TrackingServices } from '../tracking/tracking.services';
import { createDocumentAlreadyExistsError, createDocumentNotDeletedError, createDocumentNotFoundError } from './documents.errors';
import { buildOriginalDocumentKey, generateDocumentId as generateDocumentIdImpl } from './documents.models';
import { createDocumentsRepository, type DocumentsRepository } from './documents.repository';
import { getFileSha256Hash } from './documents.services';
import { createDocumentStorageService, type DocumentStorageService } from './storage/documents.storage.services';

const logger = createLogger({ namespace: 'documents:usecases' });

export async function extractDocumentText({ file }: { file: File }) {
  const { textContent, error, extractorName } = await extractTextFromFile({ file });

  if (error) {
    logger.error({ error, extractorName }, 'Error while attempting to extract text from PDF');
  }

  return {
    text: textContent ?? '',
  };
}

export async function createDocument({
  file,
  userId,
  organizationId,
  documentsRepository,
  documentsStorageService,
  generateDocumentId = generateDocumentIdImpl,
  plansRepository,
  subscriptionsRepository,
  trackingServices,
  taggingRulesRepository,
  tagsRepository,
  logger = createLogger({ namespace: 'documents:usecases' }),
}: {
  file: File;
  userId?: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  generateDocumentId?: () => string;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
  trackingServices: TrackingServices;
  taggingRulesRepository: TaggingRulesRepository;
  tagsRepository: TagsRepository;
  logger?: Logger;
}) {
  const {
    name: fileName,
    size,
    type: mimeType,
  } = file;

  await checkIfOrganizationCanCreateNewDocument({
    organizationId,
    newDocumentSize: size,
    documentsRepository,
    plansRepository,
    subscriptionsRepository,
  });

  const { hash } = await getFileSha256Hash({ file });

  // Early check to avoid saving the file and then realizing it already exists with the db constraint
  const { document: existingDocument } = await documentsRepository.getOrganizationDocumentBySha256Hash({ sha256Hash: hash, organizationId });

  const { document } = existingDocument
    ? await handleExistingDocument({
      existingDocument,
      fileName,
      organizationId,
      documentsRepository,
      tagsRepository,
      logger,
    })
    : await createNewDocument({
      file,
      fileName,
      size,
      mimeType,
      hash,
      userId,
      organizationId,
      documentsRepository,
      documentsStorageService,
      generateDocumentId,
      trackingServices,
      logger,
    });

  await applyTaggingRules({ document, taggingRulesRepository, tagsRepository });

  return { document };
}

export type CreateDocumentUsecase = Awaited<ReturnType<typeof createDocumentCreationUsecase>>;
export async function createDocumentCreationUsecase({
  db,
  config,
  logger = createLogger({ namespace: 'documents:usecases' }),
  generateDocumentId = generateDocumentIdImpl,
  documentsStorageService,
}: {
  db: Database;
  config: Config;
  logger?: Logger;
  documentsStorageService?: DocumentStorageService;
  generateDocumentId?: () => string;
}) {
  const deps = {
    documentsRepository: createDocumentsRepository({ db }),
    documentsStorageService: documentsStorageService ?? await createDocumentStorageService({ config }),
    plansRepository: createPlansRepository({ config }),
    subscriptionsRepository: createSubscriptionsRepository({ db }),
    trackingServices: createTrackingServices({ config }),
    taggingRulesRepository: createTaggingRulesRepository({ db }),
    tagsRepository: createTagsRepository({ db }),
    generateDocumentId,
    logger,
  };

  return async ({ file, userId, organizationId }: { file: File; userId?: string; organizationId: string }) => createDocument({
    file,
    userId,
    organizationId,
    ...deps,
  });
}

async function handleExistingDocument({
  existingDocument,
  fileName,
  userId,
  organizationId,
  documentsRepository,
  tagsRepository,
  logger,
}: {
  existingDocument: Document;
  fileName: string;
  userId?: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  tagsRepository: TagsRepository;
  logger: Logger;
}) {
  if (existingDocument && !existingDocument.isDeleted) {
    throw createDocumentAlreadyExistsError();
  }

  logger.info({ documentId: existingDocument.id }, 'Document already exists, restoring for deduplication');

  const [, { document: restoredDocument }] = await Promise.all([
    tagsRepository.removeAllTagsFromDocument({ documentId: existingDocument.id }),
    documentsRepository.restoreDocument({ documentId: existingDocument.id, organizationId, name: fileName, userId }),
  ]);

  return { document: restoredDocument };
}

async function createNewDocument({
  file,
  fileName,
  size,
  mimeType,
  hash,
  userId,
  organizationId,
  documentsRepository,
  documentsStorageService,
  generateDocumentId,
  trackingServices,
  logger,
}: {
  file: File;
  fileName: string;
  size: number;
  mimeType: string;
  hash: string;
  userId?: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  generateDocumentId: () => string;
  trackingServices: TrackingServices;
  logger: Logger;
}) {
  const documentId = generateDocumentId();

  const { originalDocumentStorageKey } = buildOriginalDocumentKey({
    documentId,
    organizationId,
    fileName,
  });

  const { storageKey } = await documentsStorageService.saveFile({
    file,
    storageKey: originalDocumentStorageKey,
  });

  const { text } = await extractDocumentText({ file });

  const [result, error] = await safely(documentsRepository.saveOrganizationDocument({
    id: documentId,
    name: fileName,
    organizationId,
    originalName: fileName,
    createdBy: userId,
    originalSize: size,
    originalStorageKey: storageKey,
    mimeType,
    content: text,
    originalSha256Hash: hash,
  }));

  if (error) {
    logger.error({ error }, 'Error while creating document');

    // If the document is not saved, delete the file from the storage
    await documentsStorageService.deleteFile({ storageKey: originalDocumentStorageKey });

    logger.error({ error }, 'Stored document file deleted because of error');

    throw error;
  }

  if (userId) {
    trackingServices.captureUserEvent({ userId, event: 'Document created' });
  }

  logger.info({ documentId, userId, organizationId }, 'Document created');

  return { document: result.document };
}

export async function getDocumentOrThrow({
  documentId,
  organizationId,
  documentsRepository,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
}) {
  const { document } = await documentsRepository.getDocumentById({ documentId, organizationId });

  if (!document) {
    throw createDocumentNotFoundError();
  }

  return { document };
}

export async function ensureDocumentExists({
  documentId,
  organizationId,
  documentsRepository,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
}) {
  await getDocumentOrThrow({ documentId, organizationId, documentsRepository });
}

export async function hardDeleteDocument({
  documentId,
  documentsRepository,
  documentsStorageService,
}: {
  documentId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
}) {
  await Promise.allSettled([
    documentsRepository.hardDeleteDocument({ documentId }),
    documentsStorageService.deleteFile({ storageKey: documentId }),
  ]);
}

export async function deleteExpiredDocuments({
  documentsRepository,
  documentsStorageService,
  config,
  now = new Date(),
  logger = createLogger({ namespace: 'documents:deleteExpiredDocuments' }),
}: {
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  config: Config;
  now?: Date;
  logger?: Logger;
}) {
  const { documentIds } = await documentsRepository.getExpiredDeletedDocuments({
    expirationDelayInDays: config.documents.deletedDocumentsRetentionDays,
    now,
  });

  await Promise.all(
    documentIds.map(async (documentId) => {
      const [, error] = await safely(hardDeleteDocument({ documentId, documentsRepository, documentsStorageService }));

      if (error) {
        logger.error({ documentId, error }, 'Error while deleting expired document');
      }
    }),
  );

  return {
    deletedDocumentsCount: documentIds.length,
  };
}

export async function deleteTrashDocument({
  documentId,
  organizationId,
  documentsRepository,
  documentsStorageService,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
}) {
  const { document } = await documentsRepository.getDocumentById({ documentId, organizationId });

  if (!document) {
    throw createDocumentNotFoundError();
  }

  if (!document.isDeleted) {
    throw createDocumentNotDeletedError();
  }

  await hardDeleteDocument({ documentId, documentsRepository, documentsStorageService });
}

export async function deleteAllTrashDocuments({
  organizationId,
  documentsRepository,
  documentsStorageService,
}: {
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
}) {
  const { documentIds } = await documentsRepository.getAllOrganizationTrashDocumentIds({ organizationId });

  // TODO: refactor to use batching and transaction

  const limit = pLimit(10);

  await Promise.all(
    documentIds.map(documentId => limit(() => hardDeleteDocument({ documentId, documentsRepository, documentsStorageService }))),
  );
}
