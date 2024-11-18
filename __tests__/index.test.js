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

// Add this before the describe block
const fs = require('fs');
const path = require('path');

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
      new RegExp(`Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}\\s+${expectedDiff.overall.trend}`)
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
      new RegExp(`Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}\\s+${expectedDiff.overall.trend}`)
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
      new RegExp(`Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}\\s+${expectedDiff.overall.trend}`)
    );

    // Check files section
    expectedDiff.files.forEach(file => {
      const filePattern = new RegExp(
        `${file.filename}\\s+${file.baseCoverage}\\s+${file.headCoverage}\\s+${file.difference}\\s+${file.trend}`
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
      new RegExp(`Coverage\\s+${expectedDiff.overall.baseCoverage}\\s+${expectedDiff.overall.headCoverage}\\s+${expectedDiff.overall.difference}\\s+${expectedDiff.overall.trend}`)
    );

    // Verify each file in the diff
    expectedDiff.files.forEach(file => {
      const prefix = file.isNew ? '\\+ ' : file.difference.startsWith('-') ? '- ' : '  ';
      // Create a pattern that matches both formats of the difference value
      const diffStr = file.difference.startsWith('+')
        ? `[+]\\s*${file.difference.substring(1)}`
        : file.difference;

      const pattern = new RegExp(
        `${prefix}${file.filename}\\s+${file.baseCoverage}\\s+${file.headCoverage}\\s+${diffStr}\\s+${file.trend}`
      );

      // Get the actual line for better debugging
      const actualLine = commentBody.split('\n')
        .find(line => line.includes(file.filename));

      console.log('Expected pattern:', pattern);
      console.log('Actual line:', actualLine);

      expect(actualLine).toMatch(pattern);
    });

    // Verify new files are marked with '+'
    const newFiles = expectedDiff.files.filter(f => f.isNew);
    newFiles.forEach(file => {
      expect(commentBody).toMatch(new RegExp(`\\+ ${file.filename}`));
    });
  });

  test('should include missing line numbers in coverage report', async () => {
    const { baseCoverageXML, headCoverageXML } = loadTestData('python');

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
}); 