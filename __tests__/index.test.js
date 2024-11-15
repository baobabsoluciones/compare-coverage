const core = require('@actions/core');
const { Storage } = require('@google-cloud/storage');

// Mock the dependencies
jest.mock('@actions/core');
jest.mock('@actions/github');
jest.mock('@google-cloud/storage');

// Mock environment variables
const mockEnv = {
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_BASE_REF: 'main',
  GITHUB_HEAD_REF: 'feature-branch'
};

describe('Coverage Action', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Set up environment variables
    process.env = { ...process.env, ...mockEnv };

    // Mock core.getInput values
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: '{"type": "service_account"}',
        base_coverage_path: 'coverage.xml',
        head_coverage_path: 'coverage.xml',
        min_coverage: '80',
        github_token: 'fake-token'
      };
      return inputs[name];
    });

    // Mock Storage class
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(['<coverage></coverage>'])
        })
      })
    }));
  });

  test('should fail if not run on pull request', async () => {
    // Remove PR-specific env variables
    delete process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_HEAD_REF;

    // Import the action (need to import here to ensure env vars are cleared)
    const { run } = require('../src/index');

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      'This action can only be run on pull request events'
    );
  });

  test('should construct correct GCS paths', async () => {
    const { run } = require('../src/index');

    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('repo/main/coverage.xml')
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('repo/feature-branch/coverage.xml')
    );
  });

  test('should attempt to download coverage files', async () => {
    const { run } = require('../src/index');

    await run();

    const mockBucket = Storage.mock.results[0].value.bucket();
    expect(mockBucket.file).toHaveBeenCalledTimes(2);
    expect(mockBucket.file().download).toHaveBeenCalledTimes(2);
  });
}); 