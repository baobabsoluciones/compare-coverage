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
    const baseCoveragePath = `${basePath}/${baseTimestamp}/cobertura-coverage.xml`;
    const headCoveragePath = `${headPath}/${headTimestamp}/cobertura-coverage.xml`;

    core.info(`Downloading base coverage from: ${baseCoveragePath}`);
    core.info(`Downloading head coverage from: ${headCoveragePath}`);

    // Download coverage files
    const baseCoverageContent = await downloadFile(bucket, baseCoveragePath);
    const headCoverageContent = await downloadFile(bucket, headCoveragePath);

    // Rest of your code...
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
    return content.toString();
  } catch (error) {
    throw new Error(`Failed to download file ${filePath}: ${error.message}`);
  }
}

module.exports = { run };

if (require.main === module) {
  run();
} 