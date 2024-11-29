const core = require('@actions/core');
const { Storage } = require('@google-cloud/storage');
const { run, getFilesWithCoverageChanges } = require('../src/index.js');
const github = require('@actions/github');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const ini = require('ini');

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

function loadTestData(type) {
  const baseCoverageXML = fs.readFileSync(
    path.join(__dirname, 'data', `${type}-base.xml`),
    'utf8'
  );
  const headCoverageXML = fs.readFileSync(
    path.join(__dirname, 'data', `${type}-head.xml`),
    'utf8'
  );
  const expectedDiff = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'data', `${type}-diff.json`),
    'utf8'
  ));

  return {
    baseCoverageXML,
    headCoverageXML,
    expectedDiff
  };
}

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
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'false'
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
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'false'
      };
      return inputs[name];
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid GCP credentials JSON')
    );
  });

  test('should handle missing coverage reports', async () => {
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

    // Setup the Storage mock with empty file list
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[]])
      })
    }));

    await run();

    // Verify the message was posted
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('Both branches (main and feature-branch) have no available coverage reports')
    });

    // Verify it includes the bot marker
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('<!-- Coverage Report Bot -->')
    });
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
    const { baseCoverageXML, headCoverageXML, expectedDiff } = loadTestData('javascript');

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

    // Verify comment creation
    expect(mockListComments).toHaveBeenCalled();
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringMatching(/```diff\n@@ Coverage Diff @@/)
    });

    // Verify the created comment matches the expected diff
    const commentBody = mockCreateComment.mock.calls[0][0].body;
    expect(commentBody).toMatch(/The overall coverage statistics of the PR are:/);
    expect(commentBody).toMatch(/@@ Coverage Diff @@/);
    expect(commentBody).toMatch(
      new RegExp(`\\+ Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}`)
    );

    // Check files section if there are changes
    if (expectedDiff.files.length > 0) {
      expectedDiff.files.forEach(file => {
        const filePattern = new RegExp(
          `${file.filename}\\s+${file.baseCoverage}\\s+${file.headCoverage}\\s+${file.difference}\\s+${file.trend}`
        );
        expect(commentBody).toMatch(filePattern);
      });
    }
  });

  test('should update existing coverage comment', async () => {
    // Read the coverage XML files
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

    // Mock Octokit with existing bot comment
    const mockUpdateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({
      data: [{
        id: 123,
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

    // Verify the bot comment was found and updated
    expect(mockListComments).toHaveBeenCalled();
    expect(mockUpdateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 123,
      body: expect.stringMatching(/```diff\n@@ Coverage Diff @@/)
    });

    // Verify the updated comment contains the correct coverage information
    const updatedComment = mockUpdateComment.mock.calls[0][0].body;
    expect(updatedComment).toMatch(/The overall coverage statistics of the PR are:/);
    expect(updatedComment).toMatch(/@@ Coverage Diff @@/);
    expect(updatedComment).toMatch(/## main\s+#feature-branch\s+\+\/\-\s+##/);

    // Only check for file table if there are coverage changes
    if (updatedComment.includes('The main files with changes are:')) {
      expect(updatedComment).toMatch(/## File\s+main\s+feature-branch\s+\+\/\-\s+##/);
    }
  });

  test('should create coverage diff message in correct format', async () => {
    // Read the coverage files and expected diff
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
    const expectedDiff = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'data', 'python-diff.json'),
      'utf8'
    ));

    // Set up environment variables for branch names
    process.env.GITHUB_BASE_REF = 'main';
    process.env.GITHUB_HEAD_REF = 'feature-branch';

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

    // Verify against expected diff
    const commentBody = mockCreateComment.mock.calls[0][0].body;

    // Check overall metrics
    expect(commentBody).toMatch(
      new RegExp(`- Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}`)
    );

    // Check files section if there are changes
    if (expectedDiff.files.length > 0) {
      expectedDiff.files.forEach(file => {
        const prefix = file.difference.startsWith('-') ? '- ' : '+ ';
        const filePattern = new RegExp(
          `${prefix}${file.filename}\\s+${file.baseCoverage}\\s+${file.headCoverage}\\s+${file.difference}`
        );
        expect(commentBody).toMatch(filePattern);
      });
    }
  });

  test('should handle Python coverage format', async () => {
    const { baseCoverageXML, headCoverageXML, expectedDiff } = loadTestData('python');

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

    await run();

    // Verify against expected diff
    const commentBody = mockCreateComment.mock.calls[0][0].body;
    expect(commentBody).toMatch(
      new RegExp(`- Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}`)
    );

    // Check files section
    expectedDiff.files.forEach(file => {
      const prefix = file.difference.startsWith('-') ? '- ' : '+ ';
      const filePattern = new RegExp(
        `${prefix}${file.filename}\\s+${file.baseCoverage}\\s+${file.headCoverage}\\s+${file.difference}`
      );
      expect(commentBody).toMatch(filePattern);
    });
  });

  test('should find and update bot comment correctly', async () => {
    // Read the coverage XML files
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

  test('should handle new files in coverage report', async () => {
    // Load test data
    const { baseCoverageXML, headCoverageXML, expectedDiff } = loadTestData('python-new-files');

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

    const commentBody = mockCreateComment.mock.calls[0][0].body;

    // Verify overall statistics
    expect(commentBody).toMatch(
      new RegExp(`Files\\s+${expectedDiff.overall.files.base}\\s+${expectedDiff.overall.files.head}\\s+${expectedDiff.overall.files.difference}`)
    );
    expect(commentBody).toMatch(
      new RegExp(`- Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}`)
    );

    // Verify each file in the diff
    expectedDiff.files.forEach(file => {
      const prefix = file.isNew ? '\\+ ' : file.difference.startsWith('-') ? '- ' : '\\+ ';
      const pattern = new RegExp(
        `${prefix}${file.filename.replace('/', '\\/')}\\s+${file.baseCoverage}\\s+${file.headCoverage}\\s+[+-]\\s*${file.difference.replace(/[+-]/, '')}`
      );
      expect(commentBody).toMatch(pattern);
    });

    // Verify new files are marked with '+'
    const newFiles = expectedDiff.files.filter(f => f.isNew);
    newFiles.forEach(file => {
      expect(commentBody).toMatch(new RegExp(`\\+ ${file.filename}`));
    });
  });

  test('should include missing line numbers in coverage report', async () => {
    const { baseCoverageXML, headCoverageXML } = loadTestData('python');

    // Override to show missing lines
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: '{"type": "service_account"}',
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'true'  // Set to true for this test
      };
      return inputs[name];
    });

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

    // Rest of the test remains the same...
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

    // Get the comment body
    const commentBody = mockCreateComment.mock.calls[0][0].body;

    // Verify that missing lines are included in the report
    expect(commentBody).toMatch(/Missing lines: \d+(?:-\d+)?(?:, \d+(?:-\d+)?)*$/m);

    // Verify the format of missing lines (should be either single numbers or ranges)
    const missingLinesMatch = commentBody.match(/Missing lines: ([\d\-, ]+)/);
    if (missingLinesMatch) {
      const missingLines = missingLinesMatch[1];
      // Should match format like "33-49" or "7-14, 29, 32, 43"
      expect(missingLines).toMatch(/^\d+(?:-\d+)?(?:, \d+(?:-\d+)?)*$/);
    }
  });

  test('should post message when coverage report is missing', async () => {
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

    // Setup the Storage mock with no files for base branch
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          // Only head branch has coverage
          { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn()
        })
      })
    }));

    await run();

    // Verify the error message was posted
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('Branch main has no available coverage report')
    });

    // Verify it includes the bot marker
    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('<!-- Coverage Report Bot -->')
    });
  });

  test('should handle files with python_coverage prefix', async () => {
    // Mock inputs
    process.env.INPUT_GCP_CREDENTIALS = JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      private_key: 'test-key',
      client_email: 'test@test.com'
    });
    process.env.INPUT_MIN_COVERAGE = '80';
    process.env.INPUT_GITHUB_TOKEN = 'fake-token';
    process.env.INPUT_GCP_BUCKET = 'test-bucket';
    process.env.INPUT_SHOW_MISSING_LINES = 'true';

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

    // Read the coverage XML files from external files
    const fs = require('fs');
    const path = require('path');

    const baseCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'python_coverage_base.xml'),
      'utf8'
    );

    const headCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'python_coverage_head.xml'),
      'utf8'
    );

    // Mock PR changed files with python_coverage prefix
    const mockListFiles = jest.fn().mockResolvedValue({
      data: [
        { filename: 'python_coverage/module/example.py', status: 'modified' },
        { filename: 'python_coverage/module/uncovered.py', status: 'added' }
      ]
    });

    // Mock Octokit
    const mockCreateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({ data: [] });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        pulls: {
          listFiles: mockListFiles
        },
        issues: {
          createComment: mockCreateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock with proper file structure
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockImplementation(async ({ prefix }) => {
          if (prefix.includes('main')) {
            return [[{ name: 'repo/main/20240315_120000/coverage.xml' }]];
          }
          if (prefix.includes('feature')) {
            return [[{ name: 'repo/feature/20240315_120000/coverage.xml' }]];
          }
          return [[]];
        }),
        file: jest.fn().mockReturnValue({
          download: jest.fn()
            .mockResolvedValueOnce([baseCoverageXML])
            .mockResolvedValueOnce([headCoverageXML])
        })
      })
    }));

    // Set required environment variables
    process.env.GITHUB_BASE_REF = 'main';
    process.env.GITHUB_HEAD_REF = 'feature';
    process.env.GITHUB_REPOSITORY = 'owner/repo';

    await run();

    // Verify that the file was correctly matched despite the prefix difference
    const commentBody = mockCreateComment.mock.calls[0][0].body;
    expect(commentBody).toMatch(/module\/example\.py/);
    expect(commentBody).not.toMatch(/python_coverage\/module\/example\.py/);
    expect(commentBody).toMatch(/\+ Coverage\s+50\.00%\s+100\.00%\s+50\.00%/);

    // Verify uncovered files section
    expect(commentBody).toMatch(/The following files do not have coverage information on any branch:/);
    expect(commentBody).toMatch(/- module\/uncovered\.py/);
    expect(commentBody).not.toMatch(/python_coverage\/module\/uncovered\.py/);
  });

  test('should handle files with no coverage information', async () => {
    // Mock inputs
    process.env.INPUT_GCP_CREDENTIALS = JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      private_key: 'test-key',
      client_email: 'test@test.com'
    });
    process.env.INPUT_MIN_COVERAGE = '80';
    process.env.INPUT_GITHUB_TOKEN = 'fake-token';
    process.env.INPUT_GCP_BUCKET = 'test-bucket';
    process.env.INPUT_SHOW_MISSING_LINES = 'true';

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

    // Read the coverage XML files from external files
    const fs = require('fs');
    const path = require('path');

    const baseCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'python_no_coverage_base.xml'),
      'utf8'
    );

    const headCoverageXML = fs.readFileSync(
      path.join(__dirname, 'data', 'python_no_coverage_head.xml'),
      'utf8'
    );

    // Mock PR changed files
    const mockListFiles = jest.fn().mockResolvedValue({
      data: [
        { filename: 'module/example.py', status: 'modified' },
        { filename: 'module/uncovered.py', status: 'added' }
      ]
    });

    // Mock Octokit
    const mockCreateComment = jest.fn();
    const mockListComments = jest.fn().mockResolvedValue({ data: [] });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        pulls: {
          listFiles: mockListFiles
        },
        issues: {
          createComment: mockCreateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock with proper file structure
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockImplementation(async ({ prefix }) => {
          if (prefix.includes('main')) {
            return [[{ name: 'repo/main/20240315_120000/coverage.xml' }]];
          }
          if (prefix.includes('feature')) {
            return [[{ name: 'repo/feature/20240315_120000/coverage.xml' }]];
          }
          return [[]];
        }),
        file: jest.fn().mockReturnValue({
          download: jest.fn()
            .mockResolvedValueOnce([baseCoverageXML])
            .mockResolvedValueOnce([headCoverageXML])
        })
      })
    }));

    // Set required environment variables
    process.env.GITHUB_BASE_REF = 'main';
    process.env.GITHUB_HEAD_REF = 'feature';
    process.env.GITHUB_REPOSITORY = 'owner/repo';

    await run();

    // Verify the comment content
    const commentBody = mockCreateComment.mock.calls[0][0].body;

    // Verify that covered file appears in the coverage section
    expect(commentBody).toMatch(/\+ module\/example\.py/);

    // Verify that uncovered files appear in the separate section
    expect(commentBody).toMatch(/The following files do not have coverage information on any branch:/);
    expect(commentBody).toMatch(/- module\/uncovered\.py/);

    // Verify that uncovered files don't appear in the coverage diff section
    const coverageDiffSection = commentBody.split('```diff')[1].split('```')[0];
    expect(coverageDiffSection).not.toMatch(/uncovered\.py/);
  });

  test('should highlight rows with coverage below minimum threshold', async () => {
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: '{"type": "service_account"}',
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'false'
      };
      return inputs[name];
    });
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

    const { baseCoverageXML, headCoverageXML } = loadTestData('python');

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

    const commentBody = mockCreateComment.mock.calls[0][0].body;
    expect(commentBody).toMatch(/- Coverage\s+100\.00%\s+67\.74%\s+-32\.26%/);
  });

  test('should respect show_missing_lines parameter', async () => {
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

    // Test with show_missing_lines = false
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: '{"type": "service_account"}',
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'false'
      };
      return inputs[name];
    });

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

    const { baseCoverageXML, headCoverageXML } = loadTestData('python');

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

    const commentBody = mockCreateComment.mock.calls[0][0].body;
    expect(commentBody).toMatch(/- Coverage\s+100\.00%\s+67\.74%\s+-32\.26%/);
  });

  test('should exclude files matching .coveragerc omit patterns', () => {
    // Mock coveragerc config with omit patterns
    const coverageRcConfig = {
      run: {
        omit: ['**/test_files/**', 'src/ignored_file.py']
      }
    };

    // Mock coverage data
    const baseCoverage = {
      coverage: {
        classes: [{
          class: []
        }]
      }
    };
    const headCoverage = {
      coverage: {
        classes: [{
          class: []
        }]
      }
    };

    // Mock PR changed files
    const prChangedFiles = [
      { filename: 'test_files/test_module.py' },
      { filename: 'src/ignored_file.py' },
      { filename: 'src/main.py' }
    ];

    // Call the function
    const { changedFiles, uncoveredFiles } = getFilesWithCoverageChanges(
      baseCoverage,
      headCoverage,
      prChangedFiles,
      coverageRcConfig
    );

    console.log(changedFiles);
    console.log(uncoveredFiles);

    // Verify only non-omitted files are in uncovered files
    expect(uncoveredFiles).toEqual(['src/main.py']);
  });
});

describe('Coverage Action .coveragerc Loading', () => {
  let originalCwd;
  const sourceCoverageRcPath = path.join(__dirname, 'data', '.coveragerc');
  const tempWorkspacePath = path.join(__dirname, 'temp_workspace');

  beforeEach(() => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create a temporary workspace directory if it doesn't exist
    if (!fs.existsSync(tempWorkspacePath)) {
      fs.mkdirSync(tempWorkspacePath);
    }

    // Reset environment variables
    process.env = { ...process.env, ...mockEnv };

    // Reset mocks
    jest.clearAllMocks();
    core.info.mockClear();
    core.warning.mockClear();
  });

  afterEach(() => {
    // Restore original working directory
    process.chdir(originalCwd);

    // Clean up temporary workspace
    if (fs.existsSync(tempWorkspacePath)) {
      fs.rmSync(tempWorkspacePath, { recursive: true, force: true });
    }
  });

  test('should load .coveragerc if present in workspace', async () => {
    // Spy on core.info BEFORE running the action
    const infoSpy = jest.spyOn(core, 'info');

    // Copy .coveragerc to temporary workspace
    const coverageRcContent = fs.readFileSync(sourceCoverageRcPath, 'utf-8');
    const tempCoverageRcPath = path.join(tempWorkspacePath, '.coveragerc');
    fs.writeFileSync(tempCoverageRcPath, coverageRcContent);

    // Change current working directory to temporary workspace
    process.chdir(tempWorkspacePath);

    // Mock GitHub context and other required inputs
    github.context = {
      repo: { owner: 'owner', repo: 'repo' },
      payload: { pull_request: { number: 123 } }
    };

    // Mock inputs and other dependencies as in other tests
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: '{"type": "service_account"}',
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'false'
      };
      return inputs[name];
    });

    // Mock Octokit to handle listFiles
    github.getOctokit.mockReturnValue({
      rest: {
        pulls: {
          listFiles: jest.fn().mockResolvedValue({ data: [] })
        },
        issues: {
          createComment: jest.fn(),
          listComments: jest.fn().mockResolvedValue({ data: [] })
        }
      }
    });

    // Mock Storage and other dependencies to return minimal coverage data
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/coverage.xml' },
          { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(['<?xml version="1.0"?><coverage line-rate="1.0"></coverage>'])
        })
      })
    }));

    // Spy on fs.existsSync to ensure it's called with the correct path
    const existsSyncSpy = jest.spyOn(fs, 'existsSync');

    // Run the action
    await run();

    // Verify .coveragerc path was checked
    expect(existsSyncSpy).toHaveBeenCalledWith(expect.stringContaining('.coveragerc'));

    // Get all info logs
    const infoLogs = infoSpy.mock.calls.map(call => call[0]);

    // Parse the expected omitted paths
    const parsedConfig = ini.parse(coverageRcContent);
    const expectedOmitPaths = Object.keys(parsedConfig.run)
      .filter(key => key !== 'source' && key.includes('*'))
      .join(', ');

    // Find logs that match our expectations
    const configLoadLog = infoLogs.find(log =>
      log.includes('Loaded .coveragerc configuration')
    );
    const omitPathsLog = infoLogs.find(log =>
      log.includes('Omitted paths from coverage:')
    );

    // Detailed assertions with helpful error messages
    expect(configLoadLog).not.toBeUndefined();
    expect(omitPathsLog).not.toBeUndefined();

    // Check that the omit paths log contains the expected paths
    const omitPathsInLog = omitPathsLog.split('Omitted paths from coverage:')[1].trim();
    const expectedOmitPathsArray = expectedOmitPaths.split(', ');

    expectedOmitPathsArray.forEach(path => {
      expect(omitPathsInLog).toContain(path,
        `Expected path '${path}' not found in omit paths log: ${omitPathsInLog}`
      );
    });
  });

  test('should not fail if .coveragerc is not present', async () => {
    // Change current working directory to temporary workspace
    process.chdir(tempWorkspacePath);

    // Mock GitHub context and other required inputs
    github.context = {
      repo: { owner: 'owner', repo: 'repo' },
      payload: { pull_request: { number: 123 } }
    };

    // Mock inputs and other dependencies as in other tests
    core.getInput.mockImplementation((name) => {
      const inputs = {
        gcp_credentials: '{"type": "service_account"}',
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'false'
      };
      return inputs[name];
    });

    // Mock Octokit to handle listFiles
    github.getOctokit.mockReturnValue({
      rest: {
        pulls: {
          listFiles: jest.fn().mockResolvedValue({ data: [] })
        },
        issues: {
          createComment: jest.fn(),
          listComments: jest.fn().mockResolvedValue({ data: [] })
        }
      }
    });

    // Mock Storage and other dependencies to return minimal coverage data
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/coverage.xml' },
          { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(['<?xml version="1.0"?><coverage line-rate="1.0"></coverage>'])
        })
      })
    }));

    // Run the action
    await run();

    // Verify no warnings about .coveragerc
    const warningLogs = core.warning.mock.calls.map(call => call[0]);

    // If warnings exist, log them for debugging
    if (warningLogs.length > 0) {
      console.log('Warning logs:', warningLogs);
    }

    expect(warningLogs).toHaveLength(0);
  });
}); 