import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { main } from '../../scripts/delete-provisioned-project';
import { getProvisioningContext } from '../../src/utils/new-project-env';
import { writeCiProjectEnvFile } from '../../src/utils/studio-project-env';

const project = {
  wmProjectId: 'WMPRJabc', studioProjectId: 'proj-abc', projectName: 'Fixture',
  appName: 'Fixture', appPackage: 'com.fixture', rnProjectFolder: 'Fixture-native',
};

describe('delete provisioned project', () => {
  let original: NodeJS.ProcessEnv;
  let file: string;
  beforeEach(() => {
    original = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      PATH: original.PATH, HOME: original.HOME,
      STUDIO_URL: 'https://studio.example.test', WM_USERNAME: 'user', WM_PASSWORD: 'secret',
    });
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-delete-')), 'project-env.sh');
    process.env.CI_PROJECT_ENV_FILE = file;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  });

  const service = (deleted: string[]) => ({ deleteProjectFromEnv: async (id: string) => { deleted.push(id); } });

  it('deletes only the project recorded for this build', async () => {
    writeCiProjectEnvFile(file, project, getProvisioningContext());
    const deleted: string[] = [];
    assert.equal(await main(service(deleted)), 'deleted');
    assert.deepEqual(deleted, ['proj-abc']);
  });

  it('does nothing when no project was provisioned', async () => {
    const deleted: string[] = [];
    assert.equal(await main(service(deleted)), 'skipped');
    assert.deepEqual(deleted, []);
  });

  it('refuses to delete from a different environment or account', async () => {
    writeCiProjectEnvFile(file, project, getProvisioningContext());
    process.env.STUDIO_URL = 'https://other.example.test';
    const deleted: string[] = [];
    assert.equal(await main(service(deleted)), 'skipped');
    assert.deepEqual(deleted, []);
  });
});
