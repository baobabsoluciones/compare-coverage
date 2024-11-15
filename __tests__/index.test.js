const core = require('@actions/core');
const { Storage } = require('@google-cloud/storage');
const { run } = require('../src/index');

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

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      'This action can only be run on pull request events'
    );
  });

  test('should construct correct GCS paths', async () => {
    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('repo/main/coverage.xml')
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('repo/feature-branch/coverage.xml')
    );
  });

  test('should attempt to download coverage files', async () => {
    // Create a mock bucket instance
    const mockFile = jest.fn().mockReturnValue({
      download: jest.fn().mockResolvedValue(['<coverage></coverage>'])
    });
    const mockBucket = jest.fn().mockReturnValue({
      file: mockFile
    });

    // Setup the Storage mock
    const mockStorage = {
      bucket: mockBucket
    };
    Storage.mockImplementation(() => mockStorage);

    await run();

    // Verify the bucket was accessed
    expect(mockBucket).toHaveBeenCalled();
    expect(mockFile).toHaveBeenCalledTimes(2);
  });

  test('should handle GCS download errors', async () => {
    // Mock a failed download
    const mockError = new Error('Download failed');
    const mockFile = jest.fn().mockReturnValue({
      download: jest.fn().mockRejectedValue(mockError)
    });
    const mockBucket = jest.fn().mockReturnValue({
      file: mockFile
    });

    // Setup the Storage mock
    const mockStorage = {
      bucket: mockBucket
    };
    Storage.mockImplementation(() => mockStorage);

    await run();

    // Verify error was handled
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to download file')
    );
  });

  test('should handle invalid GCP credentials', async () => {
    // Mock invalid JSON for credentials
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: 'invalid-json',
        base_coverage_path: 'coverage.xml',
        head_coverage_path: 'coverage.xml',
        min_coverage: '80',
        github_token: 'fake-token'
      };
      return inputs[name];
    });

    await run();

    // Verify error was handled
    expect(core.setFailed).toHaveBeenCalled();
  });
}); 