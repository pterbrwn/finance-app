import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function createLocalBucket(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const statePath = resolve(directory, 'state.json');
  const snapshot = async () => {
    try {
      const value = await readFile(statePath, 'utf8');
      return { value, etag: createHash('sha256').update(value).digest('hex') };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  let writes = Promise.resolve();
  return {
    async get() {
      const object = await snapshot();
      return object && { etag: object.etag, json: async () => JSON.parse(object.value) };
    },
    put(_key, value, options = {}) {
      const operation = writes.then(async () => {
        const current = await snapshot();
        const condition = options.onlyIf || {};
        if (condition.etagMatches && current?.etag !== condition.etagMatches) return null;
        if (condition.etagDoesNotMatch === '*' && current) return null;
        await writeFile(statePath + '.tmp', value, { mode: 0o600 });
        await rename(statePath + '.tmp', statePath);
        return { etag: createHash('sha256').update(value).digest('hex') };
      });
      writes = operation.catch(() => {});
      return operation;
    }
  };
}
