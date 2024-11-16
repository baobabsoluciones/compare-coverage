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
      body: expect.stringMatching(/```diff\n@@ Coverage Diff @@/)
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

    // Verify overall statistics were processed correctly
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Overall Statistics:'),
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
      body: expect.stringMatching(/```diff\n@@ Coverage Diff @@/)
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
        body: '<!-- Coverage Report Bot -->\n```diff\n@@ Coverage Diff @@'
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
      body: expect.stringMatching(/```diff\n@@ Coverage Diff @@/)
    });
  });

  test('should create coverage diff message in correct format', async () => {
    // Read the coverage XML files
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

    // Verify the comment format
    const commentBody = mockCreateComment.mock.calls[0][0].body;

    // Check for bot identifier
    expect(commentBody).toMatch(/<!-- Coverage Report Bot -->/);

    // Verify all required sections are present
    expect(commentBody).toMatch(/```diff/);
    expect(commentBody).toMatch(/@@ Coverage Diff @@/);
    expect(commentBody).toMatch(/##.*main.*#.*feature-branch.*\+\/-.*/);
    expect(commentBody).toMatch(/={3,}/); // Separator lines

    // Check alignment and formatting
    expect(commentBody).toMatch(/[+-]?\s*Coverage\s+\d{1,3}\.\d{2}%\s+\d{1,3}\.\d{2}%\s+[+-]?\d{1,3}\.\d{2}%/);
    expect(commentBody).toMatch(/\s*Files\s+\d+\s+\d+\s+[+-]?\d+/);
    expect(commentBody).toMatch(/\s*Lines\s+\d+\s+\d+\s+[+-]?\d+/);
    expect(commentBody).toMatch(/\s*Branches\s+\d+\s+\d+\s+[+-]?\d+/);
    expect(commentBody).toMatch(/\s*Hits\s+\d+\s+\d+\s+[+-]?\d+/);
    expect(commentBody).toMatch(/[-]?\s*Misses\s+\d+\s+\d+\s+[+-]?\d+/);
    expect(commentBody).toMatch(/\s*Partials\s+\d+\s+\d+\s+[+-]?\d+/);
    expect(commentBody).toMatch(/```$/);

    // Verify specific values and alignment from python-head.xml
    expect(commentBody).toMatch(/Coverage\s+100\.00%\s+67\.74%\s+-32\.26%/);
    expect(commentBody).toMatch(/Branches\s+6\s+18\s+12/);

    // Add this check after the bot identifier check:
    expect(commentBody).toMatch(/The overall coverage statistics of the PR are:/);

    // Check for files section when there are changes
    expect(commentBody).toMatch(/The main files with changes are:/);
    expect(commentBody).toMatch(/\| File \| Base Coverage \| Head Coverage \| Change \|/);
    expect(commentBody).toMatch(/\|------|---------------|---------------|--------|/);

    // Verify file entries are properly formatted
    const fileLines = commentBody.split('\n').filter(line => line.startsWith('- |') || line.startsWith('  |'));
    fileLines.forEach(line => {
      expect(line).toMatch(/^[-\s]\s\|\s[\w\/\.-]+\s\|\s\d+\.\d{2}%\s\|\s\d+\.\d{2}%\s\|\s[+-]?\d+\.\d{2}%\s\|$/);
    });

    // Verify files with coverage decrease are marked with '-'
    const decreasedLines = fileLines.filter(line => line.startsWith('- |'));
    decreasedLines.forEach(line => {
      const match = line.match(/\|\s([+-]?\d+\.\d{2})%\s\|$/);
      expect(parseFloat(match[1])).toBeLessThan(0);
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

    // Check for overall statistics
    const hasOverallStats = calls.some(call => call.includes('Overall Statistics:'));
    const hasTotalLines = calls.some(call => call.includes('Total lines:'));
    const hasCoveredLines = calls.some(call => call.includes('Covered lines:'));
    const hasCoveragePercent = calls.some(call => call.includes('Coverage:'));

    expect(hasOverallStats).toBe(true, 'Missing overall statistics');
    expect(hasTotalLines).toBe(true, 'Missing total lines');
    expect(hasCoveredLines).toBe(true, 'Missing covered lines');
    expect(hasCoveragePercent).toBe(true, 'Missing coverage percentage');

    // Verify PR comment was created with correct coverage info
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringMatching(/Coverage\s+100\.00%\s+67\.74%\s+-32\.26%/)
    });
  });

  test('should find and update bot comment correctly', async () => {
    // Add test coverage data
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

    // Mock Octokit with multiple comments including bot comment
    const mockUpdateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({
      data: [
        {
          id: 455,
          user: { type: 'User' },
          body: 'Some other comment'
        },
        {
          id: 456,
          user: { type: 'Bot' },
          body: '<!-- Coverage Report Bot -->\n```diff\n@@ Coverage Diff @@'
        },
        {
          id: 457,
          user: { type: 'Bot' },
          body: 'Some other bot comment'
        }
      ]
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

    // Verify the bot comment was found and updated
    expect(mockListComments).toHaveBeenCalled();
    expect(mockUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        comment_id: 456,
        body: expect.stringContaining('<!-- Coverage Report Bot -->')
      })
    );
  });
}); 