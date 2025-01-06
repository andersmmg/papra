import fs from 'node:fs';
import { dirname, join } from 'node:path';
import stream from 'node:stream';
import { defineStorageDriver } from '../drivers.models';
import { createFileAlreadyExistsError } from './fs.storage-driver.errors';

function ensureDirectoryExists({ path }: { path: string }) {
  return fs.promises.mkdir(
    dirname(path),
    { recursive: true },
  );
}

function checkFileExists({ path }: { path: string }) {
  return fs.promises.access(path, fs.constants.F_OK).then(() => true).catch(() => false);
}

export const FS_STORAGE_DRIVER_NAME = 'filesystem' as const;

export const fsStorageDriverFactory = defineStorageDriver(async ({ config }) => {
  const { root } = config.documentsStorage.drivers.filesystem;

  await ensureDirectoryExists({ path: root });

  return {
    name: FS_STORAGE_DRIVER_NAME,
    saveFile: async ({ file, storageKey }) => {
      const storagePath = join(root, storageKey);

      const fileExists = await checkFileExists({ path: storagePath });

      if (fileExists) {
        throw createFileAlreadyExistsError();
      }

      await ensureDirectoryExists({ path: storagePath });

      const writeStream = fs.createWriteStream(storagePath);
      stream.Readable.fromWeb(file.stream()).pipe(writeStream);

      return new Promise((resolve, reject) => {
        writeStream.on('finish', () => {
          resolve({ storageKey });
        });

        writeStream.on('error', (error) => {
          reject(error);
        });
      });
    },
    getFileStream: async ({ storageKey }) => {
      const storagePath = join(root, storageKey);

      const fileExists = await checkFileExists({ path: storagePath });

      if (!fileExists) {
        throw new Error('File not found');
      }

      const readStream = fs.createReadStream(storagePath);
      const fileStream = stream.Readable.toWeb(readStream);

      return { fileStream };
    },
  };
});
