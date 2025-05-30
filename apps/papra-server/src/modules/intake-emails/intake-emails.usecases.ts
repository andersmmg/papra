import type { DocumentsRepository } from '../documents/documents.repository';
import type { DocumentStorageService } from '../documents/storage/documents.storage.services';
import type { PlansRepository } from '../plans/plans.repository';
import type { Logger } from '../shared/logger/logger';
import type { SubscriptionsRepository } from '../subscriptions/subscriptions.repository';
import type { TaggingRulesRepository } from '../tagging-rules/tagging-rules.repository';
import type { TagsRepository } from '../tags/tags.repository';
import type { TrackingServices } from '../tracking/tracking.services';
import type { IntakeEmailsServices } from './drivers/intake-emails.drivers.models';
import type { IntakeEmailsRepository } from './intake-emails.repository';
import { safely } from '@corentinth/chisels';
import { createDocument } from '../documents/documents.usecases';
import { getOrganizationPlan } from '../plans/plans.usecases';
import { addLogContext, createLogger } from '../shared/logger/logger';
import { createIntakeEmailLimitReachedError, createIntakeEmailNotFoundError } from './intake-emails.errors';
import { getIsFromAllowedOrigin } from './intake-emails.models';

export async function createIntakeEmail({
  organizationId,
  intakeEmailsRepository,
  intakeEmailsServices,
  plansRepository,
  subscriptionsRepository,
}: {
  organizationId: string;
  intakeEmailsRepository: IntakeEmailsRepository;
  intakeEmailsServices: IntakeEmailsServices;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
}) {
  await checkIfOrganizationCanCreateNewIntakeEmail({
    organizationId,
    plansRepository,
    subscriptionsRepository,
    intakeEmailsRepository,
  });

  const { emailAddress } = await intakeEmailsServices.generateEmailAddress();

  const { intakeEmail } = await intakeEmailsRepository.createIntakeEmail({ organizationId, emailAddress });

  return { intakeEmail };
}

export function processIntakeEmailIngestion({
  fromAddress,
  recipientsAddresses,
  attachments,
  intakeEmailsRepository,
  documentsRepository,
  documentsStorageService,
  plansRepository,
  subscriptionsRepository,
  trackingServices,
  taggingRulesRepository,
  tagsRepository,
}: {
  fromAddress: string;
  recipientsAddresses: string[];
  attachments: File[];
  intakeEmailsRepository: IntakeEmailsRepository;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
  trackingServices: TrackingServices;
  taggingRulesRepository: TaggingRulesRepository;
  tagsRepository: TagsRepository;
}) {
  return Promise.all(
    recipientsAddresses.map(recipientAddress => safely(
      ingestEmailForRecipient({
        fromAddress,
        recipientAddress,
        attachments,
        intakeEmailsRepository,
        documentsRepository,
        documentsStorageService,
        plansRepository,
        subscriptionsRepository,
        trackingServices,
        taggingRulesRepository,
        tagsRepository,
      }),
    )),
  );
}

export async function ingestEmailForRecipient({
  fromAddress,
  recipientAddress,
  attachments,
  intakeEmailsRepository,
  documentsRepository,
  documentsStorageService,
  logger = createLogger({ namespace: 'intake-emails.ingest' }),
  plansRepository,
  trackingServices,
  subscriptionsRepository,
  taggingRulesRepository,
  tagsRepository,
}: {
  fromAddress: string;
  recipientAddress: string;
  attachments: File[];
  intakeEmailsRepository: IntakeEmailsRepository;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
  trackingServices: TrackingServices;
  taggingRulesRepository: TaggingRulesRepository;
  tagsRepository: TagsRepository;
  logger?: Logger;
}) {
  const { intakeEmail } = await intakeEmailsRepository.getIntakeEmailByEmailAddress({ emailAddress: recipientAddress });

  if (!intakeEmail) {
    logger.info('Intake email not found');

    return;
  }

  addLogContext({ intakeEmailId: intakeEmail.id });

  if (!intakeEmail.isEnabled) {
    logger.info('Intake email is disabled');

    return;
  }

  const isFromAllowedOrigin = getIsFromAllowedOrigin({
    origin: fromAddress,
    allowedOrigins: intakeEmail.allowedOrigins,
  });

  if (!isFromAllowedOrigin) {
    logger.warn({ fromAddress }, 'Origin not allowed');

    return;
  }

  await Promise.all(attachments.map(async (file) => {
    const [result, error] = await safely(createDocument({
      file,
      organizationId: intakeEmail.organizationId,
      documentsStorageService,
      documentsRepository,
      plansRepository,
      subscriptionsRepository,
      trackingServices,
      taggingRulesRepository,
      tagsRepository,
    }));

    if (error) {
      logger.error({ error }, 'Failed to create document for intake email ingestion');
    } else {
      logger.info({ documentId: result.document.id }, 'Document created for intake email ingestion');
    }
  }));
}

export async function checkIfOrganizationCanCreateNewIntakeEmail({
  organizationId,
  plansRepository,
  subscriptionsRepository,
  intakeEmailsRepository,
}: {
  organizationId: string;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
  intakeEmailsRepository: IntakeEmailsRepository;
}) {
  const { intakeEmailCount } = await intakeEmailsRepository.getOrganizationIntakeEmailsCount({ organizationId });
  const { organizationPlan } = await getOrganizationPlan({ organizationId, plansRepository, subscriptionsRepository });

  if (intakeEmailCount >= organizationPlan.limits.maxIntakeEmailsCount) {
    throw createIntakeEmailLimitReachedError();
  }
}

export async function deleteIntakeEmail({
  intakeEmailId,
  organizationId,
  intakeEmailsRepository,
  intakeEmailsServices,
}: {
  intakeEmailId: string;
  organizationId: string;
  intakeEmailsRepository: IntakeEmailsRepository;
  intakeEmailsServices: IntakeEmailsServices;
}) {
  const { intakeEmail } = await intakeEmailsRepository.getIntakeEmail({ intakeEmailId, organizationId });

  if (!intakeEmail) {
    throw createIntakeEmailNotFoundError();
  }

  await intakeEmailsRepository.deleteIntakeEmail({ organizationId: intakeEmail.organizationId, intakeEmailId });
  await intakeEmailsServices.deleteEmailAddress({ emailAddress: intakeEmail.emailAddress });
}
