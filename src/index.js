/**
 * GitHub Action for comparing code coverage between branches
 * Supports Java, JavaScript, and Python coverage formats
 * Version: 0.0.7
 */
const core = require('@actions/core');
const github = require('@actions/github');
const { Storage } = require('@google-cloud/storage');
const xml2js = require('xml2js');

async function run() {
  try {
    // Get inputs
    const gcpCredentials = core.getInput('gcp_credentials', { required: true });
    const minCoverage = parseFloat(core.getInput('min_coverage')) || 80;
    const githubToken = core.getInput('github_token', { required: true });
    const bucketName = core.getInput('gcp_bucket', { required: true });

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
      throw new Error('Could not find coverage reports for one or both branches');
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

    // Create PR comment message with diff-style format
    const message = [
      '```diff',
      '@@ Coverage Diff @@',
      `## ${baseBranch}    #${headBranch}    +/-  ##`,
      '===================================',
      coverageDiff >= 0
        ? `  Coverage    ${basePercent.padStart(6)}%   ${headPercent.padStart(6)}%   ${coverageDiffPercent.padStart(6)}%`
        : `- Coverage    ${basePercent.padStart(6)}%   ${headPercent.padStart(6)}%   ${coverageDiffPercent.padStart(6)}%`,
      '===================================',
      `  Files        ${String(Object.keys(baseCoverage).length).padStart(6)}    ${String(Object.keys(headCoverage).length).padStart(6)}    ${String(Object.keys(headCoverage).length - Object.keys(baseCoverage).length).padStart(6)}`,
      `  Lines        ${String(baseMetrics.lines || 0).padStart(6)}    ${String(headMetrics.lines || 0).padStart(6)}    ${String((headMetrics.lines || 0) - (baseMetrics.lines || 0)).padStart(6)}`,
      `  Branches     ${String(baseMetrics.branches || 0).padStart(6)}    ${String(headMetrics.branches || 0).padStart(6)}    ${String((headMetrics.branches || 0) - (baseMetrics.branches || 0)).padStart(6)}`,
      '===================================',
      `  Hits         ${String(baseMetrics.hits || 0).padStart(6)}    ${String(headMetrics.hits || 0).padStart(6)}    ${String((headMetrics.hits || 0) - (baseMetrics.hits || 0)).padStart(6)}`,
      // Only add minus sign if misses increased
      `${headMetrics.misses > baseMetrics.misses ? '-' : ' '} Misses       ${String(baseMetrics.misses || 0).padStart(6)}    ${String(headMetrics.misses || 0).padStart(6)}    ${String((headMetrics.misses || 0) - (baseMetrics.misses || 0)).padStart(6)}`,
      `  Partials     ${String(baseMetrics.partials || 0).padStart(6)}    ${String(headMetrics.partials || 0).padStart(6)}    ${String((headMetrics.partials || 0) - (baseMetrics.partials || 0)).padStart(6)}`,
      '```'
    ].join('\n');

    // Post or update comment to PR
    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    // Search for existing comment
    const comments = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
    });

    const botComment = comments.data.find(comment =>
      comment.user.type === 'Bot' &&
      comment.body.includes('coverage:')
    );

    if (botComment) {
      // Update existing comment
      await octokit.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: botComment.id,
        body: message
      });
      core.info('\nUpdated existing PR comment with coverage information:');
    } else {
      // Create new comment
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        body: message
      });
      core.info('\nCreated new PR comment with coverage information:');
    }

    core.info(message);

    // Log the results
    core.info(`Coverage difference: ${coverageDiffPercent}% (${coverageDiff >= 0 ? 'increased' : 'decreased'})`);
    core.info(`New lines covered in head: ${newLinesCovered}`);

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

module.exports = { run };

if (require.main === module) {
  run();
} 