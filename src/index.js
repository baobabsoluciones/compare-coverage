const core = require('@actions/core');
const github = require('@actions/github');
const { Storage } = require('@google-cloud/storage');
const xml2js = require('xml2js');

async function run() {
  try {
    // Get inputs
    const gcpCredentials = core.getInput('gcp_credentials', { required: true });
    const baseCoveragePath = core.getInput('base_coverage_path', { required: true });
    const headCoveragePath = core.getInput('head_coverage_path', { required: true });
    const minCoverage = parseFloat(core.getInput('min_coverage')) || 80;
    const githubToken = core.getInput('github_token', { required: true });

    // Parse GCP credentials
    let credentials;
    try {
      credentials = JSON.parse(gcpCredentials);
    } catch (error) {
      throw new Error(`Invalid GCP credentials JSON: ${error.message}`);
    }

    // Get repository name from GitHub context
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const BUCKET_NAME = 'your-fixed-bucket-name';

    // Get base and head branch names from environment variables
    const baseBranch = process.env.GITHUB_BASE_REF;
    const headBranch = process.env.GITHUB_HEAD_REF;

    if (!baseBranch || !headBranch) {
      throw new Error('This action can only be run on pull request events');
    }

    // Construct coverage paths using repository name and branch names
    const repoPrefix = `${repo.toLowerCase()}`;
    const actualBaseCoveragePath = `${repoPrefix}/${baseBranch}/${baseCoveragePath}`;
    const actualHeadCoveragePath = `${repoPrefix}/${headBranch}/${headCoveragePath}`;

    // Add the logging statements we're testing for
    core.info(`Base branch: ${baseBranch}, coverage path: ${actualBaseCoveragePath}`);
    core.info(`Head branch: ${headBranch}, coverage path: ${actualHeadCoveragePath}`);

    // Initialize GCP Storage
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(BUCKET_NAME);

    // Download coverage files
    const baseCoverageContent = await downloadFile(bucket, actualBaseCoveragePath);
    const headCoverageContent = await downloadFile(bucket, actualHeadCoveragePath);

    // Rest of your code...
  } catch (error) {
    core.setFailed(error.message);
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