const core = require('@actions/core');
const { Storage } = require('@google-cloud/storage');
const { run } = require('../src/index');
const github = require('@actions/github');
const xml2js = require('xml2js');

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
    // Read the JavaScript coverage XML files
    const fs = require('fs');
    const path = require('path');

    const baseCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'javascript-base.xml'),
      'utf8'
    );
    const headCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'javascript-head.xml'),
      'utf8'
    );

    // Mock GitHub context
    github.context = {
      repo: {
        owner: 'owner',
        repo: 'repo'
      },
      payload: {
        pull_request: {
          number: 123
        }
      }
    };

    // Mock Octokit
    const mockCreateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({ data: [] });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        issues: {
          createComment: mockCreateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock with JavaScript coverage files
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

    // Verify the coverage calculations and PR comment
    expect(mockListComments).toHaveBeenCalled();
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringMatching(/Coverage difference: [-\d.]+% \((increase|decrease)\)/)
    });
  });

  test('should print file statistics for JavaScript coverage', async () => {
    // Read the JavaScript coverage XML file
    const fs = require('fs');
    const path = require('path');

    const coverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'javascript-head.xml'),
      'utf8'
    );

    // Mock GitHub context
    github.context = {
      repo: {
        owner: 'owner',
        repo: 'repo'
      },
      payload: {
        pull_request: {
          number: 123
        }
      }
    };

    // Mock Octokit
    const mockCreateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({ data: [] });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        issues: {
          createComment: mockCreateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/coverage.xml' },
          { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue([coverageXML])
        })
      })
    }));

    // Clear previous calls to core.info
    core.info.mockClear();

    await run();

    // Get all calls after clearing
    const calls = core.info.mock.calls.map(call => call[0]);

    // Verify file statistics were processed correctly
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('File Statistics:'),
        expect.stringContaining('File:'),
        expect.stringContaining('Total lines:'),
        expect.stringContaining('Covered lines:'),
        expect.stringContaining('Coverage:')
      ])
    );
  });

  test('should create new coverage comment if none exists', async () => {
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
                </lines>
              </class>
            </classes>
          </package>
        </packages>
      </coverage>`;

    // Mock GitHub context
    github.context = {
      repo: {
        owner: 'owner',
        repo: 'repo'
      },
      payload: {
        pull_request: {
          number: 123
        }
      }
    };

    // Mock Octokit with no existing comments
    const mockCreateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({ data: [] });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        issues: {
          createComment: mockCreateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock
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

    expect(mockListComments).toHaveBeenCalled();
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('Base (main) coverage: 80.00%')
    });
  });

  test('should update existing coverage comment', async () => {
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
                </lines>
              </class>
            </classes>
          </package>
        </packages>
      </coverage>`;

    // Mock GitHub context
    github.context = {
      repo: {
        owner: 'owner',
        repo: 'repo'
      },
      payload: {
        pull_request: {
          number: 123
        }
      }
    };

    // Mock Octokit with existing comment
    const mockUpdateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({
      data: [{
        id: 456,
        user: { type: 'Bot' },
        body: 'Base (main) coverage: 75.00%'
      }]
    });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        issues: {
          updateComment: mockUpdateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock
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

    expect(mockListComments).toHaveBeenCalled();
    expect(mockUpdateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 456,
      body: expect.stringContaining('Base (main) coverage: 80.00%')
    });
  });

  test('should handle Python coverage format', async () => {
    // Read the Python coverage XML files
    const fs = require('fs');
    const path = require('path');

    const baseCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'python-base.xml'),
      'utf8'
    );
    const headCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'python-head.xml'),
      'utf8'
    );

    // Mock GitHub context
    github.context = {
      repo: {
        owner: 'owner',
        repo: 'repo'
      },
      payload: {
        pull_request: {
          number: 123
        }
      }
    };

    // Mock Octokit
    const mockCreateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({ data: [] });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        issues: {
          createComment: mockCreateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock with Python coverage files
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

    // Clear previous calls to core.info
    core.info.mockClear();

    await run();

    // Get all calls after clearing
    const calls = core.info.mock.calls.map(call => call[0]);

    // Check for specific Python file statistics
    const hasModuleExample = calls.some(call =>
      call.includes('File: module/example.py') ||
      call.includes('File: python_coverage/module/example.py')
    );
    const hasModuleInit = calls.some(call =>
      call.includes('File: module/__init__.py') ||
      call.includes('File: python_coverage/module/__init__.py')
    );

    expect(hasModuleExample).toBe(true, 'Missing module/example.py statistics');
    expect(hasModuleInit).toBe(true, 'Missing module/__init__.py statistics');

    // Verify PR comment was created with correct coverage info
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringMatching(/Base \(main\) coverage: 100\.00%/)
    });
  });
}); 