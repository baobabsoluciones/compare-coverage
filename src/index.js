/**
 * GitHub Action for comparing code coverage between branches
 * Supports Java, JavaScript, and Python coverage formats
 * Version: 0.0.16
 */
const core = require('@actions/core');
const github = require('@actions/github');
const { Storage } = require('@google-cloud/storage');
const xml2js = require('xml2js');
const path = require('path');
const fs = require('fs');
const ini = require('ini');
const minimatch = require('minimatch');

async function run() {
  try {
    // Get inputs
    const gcpCredentials = core.getInput('gcp_credentials', { required: true });
    const minCoverage = parseFloat(core.getInput('min_coverage')) || 80;
    const githubToken = core.getInput('github_token', { required: true });
    const bucketName = core.getInput('gcp_bucket', { required: true });
    const showMissingLines = core.getInput('show_missing_lines').toLowerCase() === 'true';

    // Load .coveragerc if it exists
    const coverageRcPath = path.resolve(process.cwd(), '.coveragerc');
    let coverageRcConfig = {};
    if (fs.existsSync(coverageRcPath)) {
      try {
        const rawConfig = fs.readFileSync(coverageRcPath, 'utf-8');
        coverageRcConfig = ini.parse(rawConfig);
        core.info(`Loaded .coveragerc configuration from ${coverageRcPath}`);

        // Extract omitted paths manually
        const omittedPaths = Object.keys(coverageRcConfig.run)
          .filter(key =>
            key !== 'source' &&
            key !== 'omit' &&
            key.includes('*')
          );

        if (omittedPaths.length > 0) {
          core.info(`Omitted paths from coverage: ${omittedPaths.join(', ')}`);
        }
      } catch (error) {
        core.warning(`Failed to parse .coveragerc: ${error.message}`);
      }
    }

    // Initialize GitHub API client early
    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    // Parse GCP credentials
    let credentials;
    try {
      credentials = JSON.parse(gcpCredentials);
    } catch (error) {
      throw new Error(`Invalid GCP credentials JSON: ${error.message}`);
    }

    // Get repository name from GitHub context
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

    // Get base and head branch names from environment variables
    const baseBranch = process.env.GITHUB_BASE_REF;
    const headBranch = process.env.GITHUB_HEAD_REF;

    if (!baseBranch || !headBranch) {
      throw new Error('This action can only be run on pull request events');
    }

    // Initialize GCP Storage
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(bucketName);

    // Construct base paths
    const repoPrefix = `${repo.toLowerCase()}`;
    const basePath = `${repoPrefix}/${baseBranch}`;
    const headPath = `${repoPrefix}/${headBranch}`;

    // Get the latest timestamp folders for both branches
    const baseTimestamp = await getLatestTimestamp(bucket, basePath);
    const headTimestamp = await getLatestTimestamp(bucket, headPath);

    if (!baseTimestamp || !headTimestamp) {
      // Create error message
      const message = [
        '<!-- Coverage Report Bot -->',
        '⚠️ Coverage Report Status:',
        '',
        '```',
        !baseTimestamp && !headTimestamp
          ? `Both branches (${baseBranch} and ${headBranch}) have no available coverage reports. Coverage statistics cannot be calculated.`
          : !baseTimestamp
            ? `Branch ${baseBranch} has no available coverage report. Coverage statistics cannot be calculated.`
            : `Branch ${headBranch} has no available coverage report. Coverage statistics cannot be calculated.`,
        '```'
      ].join('\n');

      // Post message to PR (reuse existing octokit)
      const comments = await octokit.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
      });

      const botComment = comments.data.find(comment =>
        comment.user.type === 'Bot' &&
        comment.body.includes('<!-- Coverage Report Bot -->')
      );

      if (botComment) {
        await octokit.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: botComment.id,
          body: message
        });
      } else {
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: context.payload.pull_request.number,
          body: message
        });
      }

      // Log the message but don't fail the action
      core.info('Posted coverage unavailability message to PR');
      return;
    }

    core.info(`Found latest base coverage at timestamp: ${baseTimestamp}`);
    core.info(`Found latest head coverage at timestamp: ${headTimestamp}`);

    // Construct full paths to coverage files
    const baseCoveragePath = `${basePath}/${baseTimestamp}/coverage.xml`;
    const headCoveragePath = `${headPath}/${headTimestamp}/coverage.xml`;

    core.info(`Downloading base coverage from: ${baseCoveragePath}`);
    core.info(`Downloading head coverage from: ${headCoveragePath}`);

    // Download coverage files
    const baseCoverageContent = await downloadFile(bucket, baseCoveragePath);
    const headCoverageContent = await downloadFile(bucket, headCoveragePath);

    // Parse XML files
    const parser = new xml2js.Parser();
    const baseCoverage = await parser.parseStringPromise(baseCoverageContent);
    const headCoverage = await parser.parseStringPromise(headCoverageContent);

    // Print file statistics for both base and head coverage
    core.info('\nBase branch file statistics:');
    printFileStatistics(baseCoverage);
    core.info('\nHead branch file statistics:');
    printFileStatistics(headCoverage);

    // Calculate coverage metrics
    const baseMetrics = getCoverageMetrics(baseCoverage);
    const headMetrics = getCoverageMetrics(headCoverage);

    // Calculate coverage difference (positive if head has more coverage)
    const coverageDiff = headMetrics.lineRate - baseMetrics.lineRate;
    const coverageDiffPercent = (coverageDiff * 100).toFixed(2);
    const basePercent = (baseMetrics.lineRate * 100).toFixed(2);
    const headPercent = (headMetrics.lineRate * 100).toFixed(2);

    // Calculate new lines covered in head
    const newLinesCovered = calculateNewLinesCovered(baseCoverage, headCoverage);

    // Get PR changed files (using existing octokit)
    const prChangedFiles = await getPRChangedFiles(octokit, context);
    console.log('PR Changed Files:', prChangedFiles);

    // Get files with coverage changes
    const { changedFiles, uncoveredFiles } = getFilesWithCoverageChanges(baseCoverage, headCoverage, prChangedFiles, coverageRcConfig);
    console.log('Changed Files:', changedFiles);

    // Create PR comment message with diff-style format
    const message = [
      '<!-- Coverage Report Bot -->',
      'The overall coverage statistics of the PR are:',
      '',
      '```diff',
      '@@ Coverage Diff @@',
      `## ${baseBranch}    #${headBranch}    +/-  ##`,
      '===========================================',
      `${coverageDiff < 0 ? '-' : (headPercent < minCoverage ? '-' : '+')} Coverage    ${basePercent.padStart(6)}%   ${headPercent.padStart(6)}%   ${coverageDiffPercent.padStart(6)}%`,
      '===========================================',
      `  Files        ${String(countFiles(baseCoverage)).padStart(6)}    ${String(countFiles(headCoverage)).padStart(6)}    ${String(countFiles(headCoverage) - countFiles(baseCoverage)).padStart(6)}`,
      `  Lines        ${String(baseMetrics.lines || 0).padStart(6)}    ${String(headMetrics.lines || 0).padStart(6)}    ${String((headMetrics.lines || 0) - (baseMetrics.lines || 0)).padStart(6)}`,
      `  Branches     ${String(baseMetrics.branches || 0).padStart(6)}    ${String(headMetrics.branches || 0).padStart(6)}    ${String((headMetrics.branches || 0) - (baseMetrics.branches || 0)).padStart(6)}`,
      '===========================================',
      `${headMetrics.hits > baseMetrics.hits ? '+' : ' '} Hits         ${String(baseMetrics.hits || 0).padStart(6)}    ${String(headMetrics.hits || 0).padStart(6)}    ${String((headMetrics.hits || 0) - (baseMetrics.hits || 0)).padStart(6)}`,
      `${headMetrics.misses > baseMetrics.misses ? '-' : (headMetrics.misses < baseMetrics.misses ? '+' : ' ')} Misses       ${String(baseMetrics.misses || 0).padStart(6)}    ${String(headMetrics.misses || 0).padStart(6)}    ${String((headMetrics.misses || 0) - (baseMetrics.misses || 0)).padStart(6)}`,
      `${headMetrics.partials > baseMetrics.partials ? '-' : (headMetrics.partials < baseMetrics.partials ? '+' : ' ')} Partials     ${String(baseMetrics.partials || 0).padStart(6)}    ${String(headMetrics.partials || 0).padStart(6)}    ${String((headMetrics.partials || 0) - (baseMetrics.partials || 0)).padStart(6)}`,
      '```',
      ''
    ];

    if (changedFiles.length > 0) {
      message.push('The main files with changes are:');
      message.push('');
      message.push('```diff');
      message.push('@@ File Coverage Diff @@');

      const maxWidth = Math.max(
        `## File    ${baseBranch}    ${headBranch}    +/-  ##`.length,
        ...changedFiles.map(({ filename }) => filename.length + 40)
      );
      const separator = '='.repeat(maxWidth);

      message.push(separator);
      message.push(`## File    ${baseBranch}    ${headBranch}    +/-  ##`);
      message.push(separator);

      changedFiles.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

      changedFiles.forEach(({ filename, baseCov, headCov, change, isNew, missingLines }) => {
        const changeStr = change.toFixed(2);
        const prefix = isNew
          ? '+ '
          : (change < 0 || headCov < minCoverage)
            ? '- '
            : '+ ';

        const line = `${prefix}${filename.padEnd(20)} ${baseCov.toFixed(2).padStart(6)}%   ${headCov.toFixed(2).padStart(6)}%   ${change >= 0 ? '+' : ''}${changeStr.padStart(6)}%`;
        message.push(line);

        if (showMissingLines && missingLines) {
          message.push(`   Missing lines: ${missingLines}`);
        }
      });

      message.push(separator);
      message.push('```');
    }

    // Add uncovered files section if there are any
    if (uncoveredFiles.length > 0) {
      message.push('');
      message.push('The following files do not have coverage information on any branch:');
      uncoveredFiles.forEach(file => {
        message.push(`- ${file}`);
      });
    }

    const finalMessage = message.join('\n');

    // Search for existing comment (reuse existing octokit)
    const comments = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
    });

    const botComment = comments.data.find(comment =>
      comment.user.type === 'Bot' &&
      comment.body.includes('<!-- Coverage Report Bot -->')
    );

    if (botComment) {
      // Update existing comment
      await octokit.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: botComment.id,
        body: finalMessage
      });
      core.info('\nUpdated existing PR comment with coverage information:');
    } else {
      // Create new comment
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        body: finalMessage
      });
      core.info('\nCreated new PR comment with coverage information:');
    }

    core.info(finalMessage);

    // Log the results
    core.info(`Coverage difference: ${coverageDiffPercent}% (${coverageDiff >= 0 ? 'increased' : 'decreased'})`);
    core.info(`New lines covered in head: ${newLinesCovered}`);

    // If coverage is below minimum, set action status to failed
    if (headPercent < minCoverage) {
      core.setFailed(`Coverage ${headPercent}% is below minimum required ${minCoverage}%`);
    }

  } catch (error) {
    core.setFailed(error.message);
  }
}

async function getLatestTimestamp(bucket, prefix) {
  try {
    // List all files under the prefix
    const [files] = await bucket.getFiles({ prefix: prefix + '/' });

    // Extract unique timestamp folders
    const timestamps = files
      .map(file => {
        const match = file.name.match(new RegExp(`${prefix}/(\\d{8}_\\d{6})/`));
        return match ? match[1] : null;
      })
      .filter(Boolean) // Remove nulls
      .filter((value, index, self) => self.indexOf(value) === index); // Remove duplicates

    if (timestamps.length === 0) {
      return null;
    }

    // Sort timestamps in descending order (newest first)
    timestamps.sort((a, b) => b.localeCompare(a));

    return timestamps[0];
  } catch (error) {
    throw new Error(`Failed to list files in ${prefix}: ${error.message}`);
  }
}

async function downloadFile(bucket, filePath) {
  if (!bucket || !filePath) {
    throw new Error('Bucket and filePath are required');
  }

  try {
    const file = bucket.file(filePath);
    const [content] = await file.download();
    // If content is a Buffer or array, convert to string
    return content.toString ? content.toString() : content;
  } catch (error) {
    throw new Error(`Failed to download file ${filePath}: ${error.message}`);
  }
}

function getCoverageMetrics(coverageData) {
  const coverage = coverageData.coverage;
  const classes = coverage.classes ? coverage.classes[0].class :
    coverage.packages?.[0]?.package?.reduce((acc, pkg) =>
      acc.concat(pkg.classes?.[0]?.class || []), []) || [];

  let totalLines = 0;
  let coveredLines = 0;
  let branches = parseInt(coverage.$['branches-valid']) || 0;
  let coveredBranches = parseInt(coverage.$['branches-covered']) || 0;
  let misses = 0;
  let partials = 0;

  classes.forEach(cls => {
    if (cls.lines?.[0]?.line) {
      const lines = cls.lines[0].line;
      totalLines += lines.length;
      lines.forEach(line => {
        const hits = parseInt(line.$.hits);
        if (hits > 0) coveredLines++;
        else misses++;

        // Count branch coverage if available
        if (line.$.branch === 'true') {
          const conditions = line.$.condition_coverage?.match(/\d+/g) || [];
          if (conditions.length === 2) {
            if (parseInt(conditions[0]) > 0 && parseInt(conditions[0]) < parseInt(conditions[1])) {
              partials++;
            }
          }
        }
      });
    }
  });

  return {
    lineRate: coveredLines / totalLines,
    branchRate: branches > 0 ? coveredBranches / branches : 0,
    lines: totalLines,
    hits: coveredLines,
    misses: misses,
    partials: partials,
    branches: branches,
    timestamp: coverage.$.timestamp
  };
}

function calculateNewLinesCovered(baseCoverage, headCoverage) {
  let newLinesCovered = 0;
  const baseFiles = new Map();

  // Handle Python coverage format where classes are directly under coverage
  const getClasses = (coverage) => {
    if (coverage.coverage.classes) {
      return coverage.coverage.classes[0].class;
    }
    // Handle Java/JS format
    if (coverage.coverage.packages) {
      const classes = [];
      coverage.coverage.packages[0].package.forEach(pkg => {
        if (pkg.classes?.[0]?.class) {
          classes.push(...pkg.classes[0].class);
        }
      });
      return classes;
    }
    return [];
  };

  // Index base files
  const baseClasses = getClasses(baseCoverage);
  baseClasses.forEach(cls => {
    if (cls.lines?.[0]?.line) {
      baseFiles.set(cls.$.filename, getLineCoverage(cls.lines[0].line));
    }
  });

  // Compare with head files
  const headClasses = getClasses(headCoverage);
  headClasses.forEach(cls => {
    if (cls.lines?.[0]?.line) {
      const filename = cls.$.filename;
      const headLines = getLineCoverage(cls.lines[0].line);
      const baseLines = baseFiles.get(filename) || new Map();

      // Check each line in head
      headLines.forEach((hits, lineNum) => {
        if (hits > 0 && (!baseLines.has(lineNum) || baseLines.get(lineNum) === 0)) {
          newLinesCovered++;
        }
      });
    }
  });

  return newLinesCovered;
}

function getLineCoverage(lines) {
  const coverage = new Map();
  lines.forEach(line => {
    coverage.set(parseInt(line.$.number), parseInt(line.$.hits));
  });
  return coverage;
}

function printFileStatistics(coverage) {
  try {
    let totalLines = 0;
    let coveredLines = 0;

    // Handle Python coverage format
    if (coverage.coverage.classes) {
      coverage.coverage.classes[0].class.forEach(cls => {
        if (cls.lines?.[0]?.line) {
          totalLines += cls.lines[0].line.length;
          coveredLines += cls.lines[0].line.filter(line => parseInt(line.$.hits) > 0).length;
        }
      });
    }
    // Handle Java/JS format
    else if (coverage.coverage.packages) {
      coverage.coverage.packages[0].package.forEach(pkg => {
        if (pkg.classes?.[0]?.class) {
          pkg.classes[0].class.forEach(cls => {
            if (cls.lines?.[0]?.line) {
              totalLines += cls.lines[0].line.length;
              coveredLines += cls.lines[0].line.filter(line => parseInt(line.$.hits) > 0).length;
            }
          });
        }
      });
    }

    const coveragePercent = ((coveredLines / totalLines) * 100).toFixed(2);

    core.info('\nOverall Statistics:');
    core.info(`Total lines: ${totalLines}`);
    core.info(`Covered lines: ${coveredLines}`);
    core.info(`Coverage: ${coveragePercent}%`);
    core.info('---');
  } catch (error) {
    core.warning(`Error printing file statistics: ${error.message}`);
  }
}

function getFilesWithCoverageChanges(baseCoverage, headCoverage, prChangedFiles = [], coverageRcConfig = {}) {
  const changedFiles = [];
  const baseFiles = new Map();
  const headFiles = new Map();
  const uncoveredFiles = [];

  // Helper to check if a file matches omit patterns
  const matchesOmitPattern = (filename) => {
    // Check if there's an omit section in the coveragerc config
    const omitPatterns = coverageRcConfig.run?.omit || [];

    // If no omit patterns, return false
    if (omitPatterns.length === 0) return false;

    // Normalize the filename to handle different base paths
    const normalizedFilename = filename.trim()
      .replace(/\\/g, '/')  // Convert Windows paths to Unix
      .replace(/^python_coverage\//, '')  // Remove python_coverage prefix
      .replace(/^src\//, '')  // Remove src prefix
      .replace(/^\.\//, '');  // Remove ./ prefix

    return omitPatterns.some(pattern => {
      // Normalize pattern and convert shell-style glob to minimatch pattern
      let normalizedPattern = pattern.trim()
        .replace(/\\/g, '/')  // Convert Windows paths to Unix
        .replace(/^\.\//, '')  // Remove ./ prefix
        .replace(/^\*\//g, '**/') // Convert leading */ to **/ for recursive matching
        .replace(/\/\*$/g, '/**'); // Convert trailing /* to /** for recursive matching

      // Remove src/ prefix from pattern if it exists
      normalizedPattern = normalizedPattern.replace(/^src\//, '');

      // Try both exact match and with leading **/ for nested paths
      return minimatch.minimatch(normalizedFilename, normalizedPattern, { dot: true }) ||
        minimatch.minimatch(normalizedFilename, `**/${normalizedPattern}`, { dot: true });
    });
  };

  // Helper to normalize file paths by removing python_coverage prefix
  const normalizePath = (path) => {
    return path.replace(/^python_coverage\//, '');
  };

  // Helper to calculate file coverage and get missing lines
  const calculateFileCoverage = (cls) => {
    if (!cls.lines?.[0]?.line) return null;
    const lines = cls.lines[0].line;
    const covered = lines.filter(line => parseInt(line.$.hits) > 0).length;
    const missingLines = lines
      .filter(line => parseInt(line.$.hits) === 0)
      .map(line => parseInt(line.$.number))
      .sort((a, b) => a - b);

    // Group consecutive numbers into ranges
    const ranges = missingLines.reduce((acc, curr, i) => {
      if (i === 0) {
        acc.push([curr]);
      } else if (curr === missingLines[i - 1] + 1) {
        acc[acc.length - 1].push(curr);
      } else {
        acc.push([curr]);
      }
      return acc;
    }, []);

    // Format ranges as strings
    const missingRanges = ranges.map(range =>
      range.length === 1 ? `${range[0]}` : `${range[0]}-${range[range.length - 1]}`
    ).join(', ');

    return {
      coverage: (covered / lines.length) * 100,
      missingRanges
    };
  };

  // Process base coverage
  if (baseCoverage.coverage.classes) {
    baseCoverage.coverage.classes[0].class.forEach(cls => {
      const coverage = calculateFileCoverage(cls);
      if (coverage !== null) {
        baseFiles.set(normalizePath(cls.$.filename), coverage);
      }
    });
  } else if (baseCoverage.coverage.packages) {
    baseCoverage.coverage.packages[0].package.forEach(pkg => {
      pkg.classes?.[0]?.class.forEach(cls => {
        const coverage = calculateFileCoverage(cls);
        if (coverage !== null) {
          baseFiles.set(normalizePath(cls.$.filename), coverage);
        }
      });
    });
  }

  // Process head coverage similarly
  if (headCoverage.coverage.classes) {
    headCoverage.coverage.classes[0].class.forEach(cls => {
      const coverage = calculateFileCoverage(cls);
      if (coverage !== null) {
        headFiles.set(normalizePath(cls.$.filename), coverage);
      }
    });
  } else if (headCoverage.coverage.packages) {
    headCoverage.coverage.packages[0].package.forEach(pkg => {
      pkg.classes?.[0]?.class.forEach(cls => {
        const coverage = calculateFileCoverage(cls);
        if (coverage !== null) {
          headFiles.set(normalizePath(cls.$.filename), coverage);
        }
      });
    });
  }

  // Compare coverages
  const allFiles = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  allFiles.forEach(filename => {
    const baseCov = baseFiles.get(filename)?.coverage || 0;
    const headCov = headFiles.get(filename)?.coverage || 0;
    const change = headCov - baseCov;
    const isNew = !baseFiles.has(filename);
    const missingLines = headFiles.get(filename)?.missingRanges || '';

    if (Math.abs(change) > 0.01 || isNew) {
      changedFiles.push({
        filename,
        baseCov,
        headCov,
        change,
        isNew,
        missingLines
      });
    }
  });

  // Process PR changed files
  prChangedFiles.forEach(({ filename }) => {
    // Only process source code files
    if (filename.match(/\.(py|js|java|jsx|ts|tsx)$/)) {
      const normalizedFilename = normalizePath(filename);

      // Check if file matches omit patterns
      if (matchesOmitPattern(normalizedFilename)) {
        core.info(`Skipping uncovered file due to .coveragerc omit: ${normalizedFilename}`);
        return;
      }

      // If file isn't in either coverage report but was changed in PR
      if (!baseFiles.has(normalizedFilename) && !headFiles.has(normalizedFilename)) {
        uncoveredFiles.push(normalizedFilename);
      }
    }
  });

  return { changedFiles, uncoveredFiles };
}

function countFiles(coverage) {
  let count = 0;
  if (coverage.coverage.classes) {
    // Python format
    coverage.coverage.packages.forEach(pkg => {
      pkg.classes.forEach(cls => {
        cls.class.forEach(c => {
          if (c.$.filename) count++;
        });
      });
    });
  } else if (coverage.coverage.packages) {
    // Java/JS format
    coverage.coverage.packages[0].package.forEach(pkg => {
      pkg.classes?.[0]?.class.forEach(cls => {
        if (cls.$.filename) count++;
      });
    });
  }
  return count;
}

async function getPRChangedFiles(octokit, context) {
  try {
    const response = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
    });

    return response.data.map(file => ({
      filename: file.filename,
      status: file.status
    }));
  } catch (error) {
    core.warning(`Failed to fetch PR changed files: ${error.message}`);
    return [];
  }
}

module.exports = { run, getFilesWithCoverageChanges };

if (require.main === module) {
  run();
} 