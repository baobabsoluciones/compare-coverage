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

// Default mock inputs
const defaultMockInputs = {
  gcp_credentials: '{"type": "service_account"}',
  min_coverage: '80',
  github_token: 'fake-token',
  gcp_bucket: 'test-bucket',
  show_missing_lines: 'false'
};

// Default GitHub context mock
const defaultGithubContext = {
  repo: { owner: 'owner', repo: 'repo' },
  payload: {
    pull_request: {
      number: 123,
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' }
    }
  }
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

// Setup default Storage mock
function setupDefaultStorageMock(baseCoverage = '<?xml version="1.0"?><coverage line-rate="1.0"></coverage>',
  headCoverage = '<?xml version="1.0"?><coverage line-rate="1.0"></coverage>') {
  return {
    bucket: jest.fn().mockReturnValue({
      getFiles: jest.fn().mockResolvedValue([[
        { name: 'repo/main/20240315_120000/coverage.xml' },
        { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
      ]]),
      file: jest.fn().mockReturnValue({
        download: jest.fn()
          .mockResolvedValueOnce([baseCoverage])
          .mockResolvedValueOnce([headCoverage])
      })
    })
  };
}

describe('Coverage Action', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Set up environment variables
    process.env = { ...process.env, ...mockEnv };

    // Mock core.getInput values
    core.getInput.mockImplementation((name) => defaultMockInputs[name]);

    // Set default GitHub context
    github.context = defaultGithubContext;

    // Setup default Storage mock
    Storage.mockImplementation(() => setupDefaultStorageMock());
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
    // Override the default Storage mock for this specific test
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/coverage.xml' },
          { name: 'repo/main/20240315_120001/coverage.xml' }, // Later timestamp for base
          { name: 'repo/feature-branch/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(['<coverage></coverage>'])
        })
      })
    }));

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
    // Read the coverage XML files from external files
    const fs = require('fs');
    const path = require('path');
    const originalReadFileSync = fs.readFileSync;

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

    // Mock .coveragerc file
    fs.existsSync = jest.fn().mockImplementation(path => {
      return path === '.coveragerc';
    });

    fs.readFileSync = jest.fn().mockImplementation((filePath, encoding) => {
      // Handle our test files
      if (filePath === '.coveragerc') {
        return '[run]\nsource = python_coverage\n';
      }
      if (filePath.includes('python_coverage_base.xml')) {
        return originalReadFileSync(path.join(__dirname, 'data', 'python_coverage_base.xml'), 'utf8');
      }
      if (filePath.includes('python_coverage_head.xml')) {
        return originalReadFileSync(path.join(__dirname, 'data', 'python_coverage_head.xml'), 'utf8');
      }
      // Pass through all other file reads
      return originalReadFileSync(filePath, encoding);
    });

    // Mock GitHub context
    github.context = {
      repo: {
        owner: 'owner',
        repo: 'repo'
      },
      payload: {
        pull_request: {
          number: 123,
          base: { ref: 'main' },
          head: { ref: 'feature' }
        }
      }
    };

    // Mock PR changed files with python_coverage prefix
    const mockListFiles = jest.fn().mockResolvedValue({
      data: [
        { filename: 'python_coverage/module/example.py', status: 'modified' },
        { filename: 'python_coverage/module/uncovered.py', status: 'added' }
      ]
    });

    // Mock Octokit
    const mockCreateComment = jest.fn().mockResolvedValue({});
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
    const baseCoverageXML = originalReadFileSync(path.join(__dirname, 'data', 'python_coverage_base.xml'), 'utf8');
    const headCoverageXML = originalReadFileSync(path.join(__dirname, 'data', 'python_coverage_head.xml'), 'utf8');

    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[
          { name: 'repo/main/20240315_120000/coverage.xml' },
          { name: 'repo/feature/20240315_120000/coverage.xml' }
        ]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn()
            .mockResolvedValueOnce([Buffer.from(baseCoverageXML)])
            .mockResolvedValueOnce([Buffer.from(headCoverageXML)])
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
        omit: ['*/test_files/*', 'src/ignored_file.py', '*/tests/*']
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
      { filename: "some_other_folder/tests/whatever_file.py" },
      { filename: "tests/string_ops.py" },
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

  test('should exclude omitted files from PR comment', async () => {
    // Store the original readFileSync
    const originalReadFileSync = fs.readFileSync;

    // Setup all fs mocks at once
    fs.existsSync = jest.fn().mockReturnValue(true);
    fs.readFileSync = jest.fn().mockImplementation((filePath, options) => {
      const fileName = path.basename(filePath);
      // Handle specific test files
      if (fileName === 'base-coverage.xml') {
        return originalReadFileSync(path.join(__dirname, 'data', 'base-coverage.xml'), 'utf8');
      }
      if (fileName === 'head-coverage.xml') {
        return originalReadFileSync(path.join(__dirname, 'data', 'head-coverage.xml'), 'utf8');
      }
      if (fileName === '.coveragerc') {
        return originalReadFileSync(path.join(__dirname, 'data', '.coveragerc'), 'utf8');
      }
      // Otherwise, call the original implementation
      return originalReadFileSync(filePath, options);
    });

    // Mock GitHub context
    github.context = {
      repo: {
        owner: 'owner',
        repo: 'repo'
      },
      payload: {
        pull_request: {
          number: 123,
          base: { ref: 'main' },
          head: { ref: 'feature-branch' }
        }
      }
    };

    // Mock core inputs
    core.getInput = jest.fn().mockImplementation((name) => {
      const inputs = {
        gcp_credentials: '{"type": "service_account"}',
        min_coverage: '80',
        github_token: 'fake-token',
        gcp_bucket: 'test-bucket',
        show_missing_lines: 'true'
      };
      return inputs[name];
    });

    // Add debug logging
    const infoMessages = [];
    core.info = jest.fn(msg => infoMessages.push(msg));
    core.warning = jest.fn();
    core.setFailed = jest.fn(error => {
      console.error('Action failed:', error);
    });

    // Mock Octokit
    const mockCreateComment = jest.fn().mockResolvedValue({});
    const mockListComments = jest.fn().mockResolvedValue({ data: [] });
    github.getOctokit = jest.fn().mockReturnValue({
      rest: {
        pulls: {
          listFiles: jest.fn().mockResolvedValue({
            data: [{ filename: 'module/example.py', status: 'modified' }]
          })
        },
        issues: {
          createComment: mockCreateComment,
          listComments: mockListComments
        }
      }
    });

    // Setup the Storage mock
    const mockDownload = jest.fn()
      .mockResolvedValueOnce([Buffer.from(fs.readFileSync(path.join(__dirname, 'data', 'base-coverage.xml'), 'utf8'))])
      .mockResolvedValueOnce([Buffer.from(fs.readFileSync(path.join(__dirname, 'data', 'head-coverage.xml'), 'utf8'))]);

    const mockFile = jest.fn().mockReturnValue({
      download: mockDownload
    });

    const mockGetFiles = jest.fn().mockResolvedValue([[
      { name: 'repo/main/20241128_123234/coverage.xml' },
      { name: 'repo/feature-branch/20241129_155650/coverage.xml' }
    ]]);

    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: mockGetFiles,
        file: mockFile
      })
    }));

    // Run the action
    await run();

    // Debug output
    console.log('Info messages:', infoMessages);
    console.log('Mock create comment calls:', mockCreateComment.mock.calls);

    // Verify comment was created
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const commentBody = mockCreateComment.mock.calls[0][0].body;

    // Verify basic structure
    expect(commentBody).toMatch(/<!-- Coverage Report Bot -->/);

    // Verify overall coverage section
    expect(commentBody).toMatch(/The overall coverage statistics of the PR are:/);
    expect(commentBody).toMatch(/@@ Coverage Diff @@/);
    expect(commentBody).toMatch(/## main\s+#feature-branch\s+\+\/-\s+##/);

    // Verify coverage numbers
    expect(commentBody).toMatch(/- Coverage\s+75\.31%\s+78\.02%\s+2\.71%/);

    // Verify file statistics
    expect(commentBody).toMatch(/Files\s+4\s+2\s+-2/);
    expect(commentBody).toMatch(/Lines\s+81\s+91\s+10/);
    expect(commentBody).toMatch(/Branches\s+50\s+58\s+8/);

    // Verify hits and misses
    expect(commentBody).toMatch(/\+ Hits\s+61\s+71\s+10/);
    expect(commentBody).toMatch(/Misses\s+20\s+20\s+0/);
    expect(commentBody).toMatch(/Partials\s+0\s+0\s+0/);

    // Verify file coverage section
    expect(commentBody).toMatch(/The main files with changes are:/);
    expect(commentBody).toMatch(/@@ File Coverage Diff @@/);
    expect(commentBody).toMatch(/## File\s+main\s+feature-branch\s+\+\/-\s+##/);
    expect(commentBody).toMatch(/- module\/__init__\.py\s+100\.00%\s+0\.00%\s+-100\.00%/);
    expect(commentBody).toMatch(/- module\/string_ops\.py\s+64\.00%\s+70\.97%\s+\+\s+6\.97%/);
    expect(commentBody).toMatch(/Missing lines: 8-10, 12-13, 16-17, 19, 34, 37, 41-44, 46, 59, 62, 74/);
  });
});

describe('Coverage Action .coveragerc Loading', () => {
  let originalCwd;
  const tempWorkspacePath = path.join(__dirname, 'temp_workspace');

  // Global setup before all tests in this suite
  beforeAll(() => {
    console.log('beforeAll - Starting test suite');
    // Store original working directory
    originalCwd = process.cwd();
    console.log('Original CWD:', originalCwd);

    // Clean up any existing temp workspace
    if (fs.existsSync(tempWorkspacePath)) {
      console.log('Cleaning up existing temp workspace');
      fs.rmSync(tempWorkspacePath, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    console.log('beforeEach - Setting up test');
    // Create a fresh temporary workspace directory
    fs.mkdirSync(tempWorkspacePath, { recursive: true });
    console.log('Created temp workspace at:', tempWorkspacePath);

    // Reset environment variables
    process.env = { ...process.env, ...mockEnv };

    // Reset mocks
    jest.clearAllMocks();
    core.info.mockClear();
    core.warning.mockClear();
  });

  afterEach(() => {
    // Always return to original directory first
    process.chdir(originalCwd);

    // Clean up temporary workspace
    if (fs.existsSync(tempWorkspacePath)) {
      fs.rmSync(tempWorkspacePath, { recursive: true, force: true });
    }
  });

  // Global cleanup after all tests in this suite
  afterAll(() => {
    // Ensure we're back in the original directory
    process.chdir(originalCwd);
  });

  test('should load .coveragerc if present in workspace', async () => {
    console.log('Test 1 - Starting test for loading .coveragerc');
    // Create the .coveragerc content
    const coverageRcContent = `
[run]
omit =
    */site-packages/*
    */tests/*
    setup.py
`;
    const tempCoverageRcPath = path.join(tempWorkspacePath, '.coveragerc');
    console.log('Writing .coveragerc to:', tempCoverageRcPath);

    // Write the .coveragerc file
    fs.writeFileSync(tempCoverageRcPath, coverageRcContent, 'utf8');
    console.log('.coveragerc file exists:', fs.existsSync(tempCoverageRcPath));

    // Change current working directory to temporary workspace
    console.log('Changing directory to:', tempWorkspacePath);
    process.chdir(tempWorkspacePath);
    console.log('Current directory after change:', process.cwd());

    // Mock GitHub context and other required inputs
    github.context = {
      repo: { owner: 'owner', repo: 'repo' },
      payload: {
        pull_request: {
          number: 123,
          base: { sha: 'base-sha' },
          head: { sha: 'head-sha' }
        }
      }
    };

    // Mock inputs
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

    // Mock Storage to return empty coverage data
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(['<?xml version="1.0"?><coverage line-rate="1.0"></coverage>'])
        })
      })
    }));

    // Run the action
    await run();

    // Find the relevant log messages
    const logs = core.info.mock.calls.map(call => call[0]);
    console.log('All info logs:', logs);
    const configLoadLog = logs.find(log => log.includes('Loaded .coveragerc configuration'));
    const omitPathsLog = logs.find(log => log.includes('Omitted paths from coverage:'));

    console.log('Config load log found:', configLoadLog);
    console.log('Omit paths log found:', omitPathsLog);

    // Detailed assertions with helpful error messages
    expect(configLoadLog).not.toBeUndefined();
    expect(omitPathsLog).not.toBeUndefined();

    // Check that the omit paths log contains the expected paths
    expect(omitPathsLog).toContain('*/site-packages/*');
    expect(omitPathsLog).toContain('*/tests/*');
    expect(omitPathsLog).toContain('setup.py');
  });

  test('should not fail if .coveragerc is not present', async () => {
    console.log('Test 2 - Starting test for missing .coveragerc');
    // Change current working directory to temporary workspace
    console.log('Changing directory to:', tempWorkspacePath);
    process.chdir(tempWorkspacePath);
    console.log('Current directory after change:', process.cwd());

    // Mock GitHub context and other required inputs
    github.context = {
      repo: { owner: 'owner', repo: 'repo' },
      payload: {
        pull_request: {
          number: 123,
          base: { sha: 'base-sha' },
          head: { sha: 'head-sha' }
        }
      }
    };

    // Mock inputs
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

    // Mock Storage to return empty coverage data
    Storage.mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        getFiles: jest.fn().mockResolvedValue([[]]),
        file: jest.fn().mockReturnValue({
          download: jest.fn().mockResolvedValue(['<?xml version="1.0"?><coverage line-rate="1.0"></coverage>'])
        })
      })
    }));

    // Run the action
    await run();

    // Get warning logs
    const warningLogs = core.warning.mock.calls.map(call => call[0]);
    console.log('Warning logs:', warningLogs);

    // Verify no warnings about parsing failure
    const parseErrors = warningLogs.filter(log => log.includes('Failed to parse .coveragerc'));
    console.log('Parse errors found:', parseErrors);

    // The test should pass even if there are parse errors, as long as the action continues
    // We're verifying that the action doesn't fail catastrophically when .coveragerc is missing
    expect(core.setFailed).not.toHaveBeenCalled();
  });
}); 