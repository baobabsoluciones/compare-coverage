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
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket'
      };
      return inputs[name];
    });

    // Mock Storage class with getFiles functionality
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/cobertura-coverage.xml' },
          { name: 'repo/main/20240315_120001/cobertura-coverage.xml' },
          { name: 'repo/feature-branch/20240315_120000/cobertura-coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(['<coverage></coverage>'])
        })
      })
    }));
  });

  test('should fail if not run on pull request', async () => {
    delete process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_HEAD_REF;

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      'This action can only be run on pull request events'
    );
  });

  test('should find latest timestamp folders', async () => {
    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Found latest base coverage at timestamp: 20240315_120001')
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Found latest head coverage at timestamp: 20240315_120000')
    );
  });

  test('should attempt to download coverage files', async () => {
    // Create mock functions
    const mockDownload = jest.fn().mockResolvedValue(['<coverage></coverage>']);
    const mockFile = jest.fn().mockReturnValue({
      download: mockDownload
    });
    const mockGetFiles = jest.fn().mockResolvedValue([[
      { name: 'repo/main/20240315_120000/cobertura-coverage.xml' },
      { name: 'repo/feature-branch/20240315_120000/cobertura-coverage.xml' }
    ]]);
    const mockBucket = jest.fn().mockReturnValue({
      getFiles: mockGetFiles,
      file: mockFile
    });

    // Setup the Storage mock
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: mockGetFiles,
        file: mockFile
      })
    }));

    await run();

    // Verify the bucket operations
    expect(mockGetFiles).toHaveBeenCalled();
    expect(mockFile).toHaveBeenCalledTimes(2); // Should be called for both base and head
    expect(mockDownload).toHaveBeenCalledTimes(2); // Should be called for both files
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Downloading base coverage from:')
    );
  });

  test('should handle GCS download errors', async () => {
    const mockError = new Error('Download failed');
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockRejectedValue(mockError)
      })
    }));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to list files in')
    );
  });

  test('should handle invalid GCP credentials', async () => {
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: 'invalid-json',
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket'
      };
      return inputs[name];
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid GCP credentials JSON')
    );
  });

  test('should handle missing coverage reports', async () => {
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[]])
      })
    }));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Could not find coverage reports')
    );
  });
}); 