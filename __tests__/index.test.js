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

  test('should calculate coverage differences correctly', async () => {
    // Mock coverage files with different coverage rates
    const baseCoverageXML = `
      <coverage line-rate="0.8" branch-rate="0.75">
        <packages>
          <package>
            <classes>
              <class filename="file1.js">
                <lines>
                  <line number="1" hits="1"/>
                  <line number="2" hits="0"/>
                </lines>
              </class>
            </classes>
          </package>
        </packages>
      </coverage>`;

    const headCoverageXML = `
      <coverage line-rate="0.85" branch-rate="0.80">
        <packages>
          <package>
            <classes>
              <class filename="file1.js">
                <lines>
                  <line number="1" hits="1"/>
                  <line number="2" hits="1"/>
                  <line number="3" hits="1"/>
                </lines>
              </class>
            </classes>
          </package>
        </packages>
      </coverage>`;

    // Setup the Storage mock with our test coverage files
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/coverage.xml' },
          { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn()
            .mockResolvedValueOnce([baseCoverageXML])
            .mockResolvedValueOnce([headCoverageXML])
        })
      })
    }));

    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Coverage difference: 5.00%')
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('New lines covered in head: 2')
    );
  });

  test('should print file statistics', async () => {
    const coverageXML = `
      <coverage line-rate="0.85" branch-rate="0.80">
        <packages>
          <package name="default">
            <classes>
              <class filename="src/index.js" name="index.js">
                <lines>
                  <line number="1" hits="1"/>
                  <line number="2" hits="1"/>
                  <line number="3" hits="0"/>
                  <line number="4" hits="1"/>
                </lines>
              </class>
            </classes>
          </package>
        </packages>
      </coverage>`;

    // Setup the Storage mock with our test coverage files
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/coverage.xml' },
          { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue([coverageXML]) // Return the XML directly, not in an array
        })
      })
    }));

    // Clear previous calls to core.info
    core.info.mockClear();

    await run();

    // Get all calls after clearing
    const calls = core.info.mock.calls.map(call => call[0]);

    // Debug output
    console.log('All core.info calls:', JSON.stringify(calls, null, 2));

    // Check for the presence of specific strings
    const hasFile = calls.some(call => call.includes('File Statistics:'));
    const hasFilename = calls.some(call => call.includes('File: src/index.js'));
    const hasTotal = calls.some(call => call.includes('Total lines: 4'));
    const hasCovered = calls.some(call => call.includes('Covered lines: 3'));
    const hasCoverage = calls.some(call => call.includes('Coverage: 75.00%'));

    // Debug output for each check
    if (!hasFile) console.log('Missing "File Statistics:" header');
    if (!hasFilename) console.log('Missing filename');
    if (!hasTotal) console.log('Missing total lines');
    if (!hasCovered) console.log('Missing covered lines');
    if (!hasCoverage) console.log('Missing coverage percentage');

    expect(hasFile).toBe(true);
    expect(hasFilename).toBe(true);
    expect(hasTotal).toBe(true);
    expect(hasCovered).toBe(true);
    expect(hasCoverage).toBe(true);
  });
}); 