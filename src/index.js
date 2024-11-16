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

    // Create PR comment message
    const message = [
      `Base (${baseBranch}) coverage: ${basePercent}%`,
      `Head (${headBranch}) coverage: ${headPercent}%`,
      `Coverage difference: ${coverageDiffPercent}% (${coverageDiff >= 0 ? 'increase' : 'decrease'})`
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

    // Calculate new lines covered in head
    const newLinesCovered = calculateNewLinesCovered(baseCoverage, headCoverage);

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
  return {
    lineRate: parseFloat(coverage.$['line-rate']),
    branchRate: parseFloat(coverage.$['branch-rate']),
    complexity: parseFloat(coverage.$.complexity || 0),
    timestamp: coverage.$.timestamp
  };
}

function calculateNewLinesCovered(baseCoverage, headCoverage) {
  let newLinesCovered = 0;
  const baseFiles = new Map();

  // Index base files - handle both Java/JS and Python coverage formats
  const basePackages = baseCoverage.coverage.packages?.[0]?.package ||
    [{ classes: [{ class: getClassesFromPackages(baseCoverage) }] }];

  basePackages.forEach(pkg => {
    const classes = pkg.classes?.[0]?.class || [];
    classes.forEach(cls => {
      baseFiles.set(cls.$.filename, getLineCoverage(cls.lines[0].line));
    });
  });

  // Compare with head files
  const headPackages = headCoverage.coverage.packages?.[0]?.package ||
    [{ classes: [{ class: getClassesFromPackages(headCoverage) }] }];

  headPackages.forEach(pkg => {
    const classes = pkg.classes?.[0]?.class || [];
    classes.forEach(cls => {
      const filename = cls.$.filename;
      const headLines = getLineCoverage(cls.lines[0].line);
      const baseLines = baseFiles.get(filename) || new Map();

      // Check each line in head
      headLines.forEach((hits, lineNum) => {
        if (hits > 0 && (!baseLines.has(lineNum) || baseLines.get(lineNum) === 0)) {
          newLinesCovered++;
        }
      });
    });
  });

  return newLinesCovered;
}

function getClassesFromPackages(coverage) {
  // Handle Python coverage format where classes are directly under coverage
  if (!coverage.coverage.packages && coverage.coverage.classes) {
    return coverage.coverage.classes[0].class;
  }

  // Handle case where there are no classes
  if (!coverage.coverage.packages && !coverage.coverage.classes) {
    core.warning('No coverage data found in expected format');
    return [];
  }

  // For Java/JS format, return empty array if packages exist (will be handled by main logic)
  return [];
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
    let classes = [];

    if (coverage.coverage.packages) {
      coverage.coverage.packages[0].package.forEach(pkg => {
        if (pkg.classes && pkg.classes[0] && pkg.classes[0].class) {
          const validClasses = pkg.classes[0].class.filter(cls => {
            const hasLines = cls.lines &&
              cls.lines[0] &&
              cls.lines[0].line &&
              Array.isArray(cls.lines[0].line) &&
              cls.lines[0].line.length > 0;
            return hasLines;
          });
          classes = classes.concat(validClasses);
        }
      });
    }

    classes.forEach(cls => {
      const filename = cls.$.filename;
      const lines = cls.lines[0].line;
      const totalLines = lines.length;
      const coveredLines = lines.filter(line => parseInt(line.$.hits) > 0).length;
      const coveragePercent = ((coveredLines / totalLines) * 100).toFixed(2);

      core.info('\nFile Statistics:');
      core.info(`File: ${filename}`);
      core.info(`Total lines: ${totalLines}`);
      core.info(`Covered lines: ${coveredLines}`);
      core.info(`Coverage: ${coveragePercent}%`);
      core.info('---');
    });
  } catch (error) {
    core.warning(`Error printing file statistics: ${error.message}`);
  }
}

module.exports = { run };

if (require.main === module) {
  run();
} 