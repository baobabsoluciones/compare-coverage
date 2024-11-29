# Coverage Comparison Action

A GitHub Action that compares code coverage between branches by analyzing coverage reports stored in Google Cloud Storage. This action supports Java, JavaScript, and Python coverage formats.

## Features

- Compares code coverage between base and head branches in pull requests
- Supports multiple programming languages (Java, JavaScript, Python)
- Creates or updates PR comments with detailed coverage information
- Shows coverage trends with visual indicators (📈 📉)
- Highlights files with significant coverage changes
- Optional display of uncovered line ranges
- Fails the check if coverage falls below minimum threshold
- Tracks new files and coverage changes in PR-modified files
- Intelligently handles path prefixes (e.g., `python_coverage/`) to match files between PR changes and coverage reports
- **New: Supports `.coveragerc` configuration file**

### .coveragerc Support

The action now supports reading a `.coveragerc` file in your repository. This allows you to:

- Specify files to be omitted from coverage reports
- Configure coverage measurement settings

#### Omitting Files

In your `.coveragerc` file, you can use the `omit` section under `[run]` to exclude specific files or patterns from coverage reports:

```ini
[run]
omit =
    **/test_files/**
    src/ignored_file.py
    tests/*
```

Files matching these patterns will:

- Be excluded from the list of uncovered files
- Not trigger coverage warnings or failures

This feature is particularly useful for:

- Excluding test files
- Ignoring generated code
- Skipping files that don't require full coverage

**Flexible Matching:**

- Patterns can match full paths or individual file/directory names
- Works across different project structures
- Supports wildcard and glob-style patterns

## Usage

This action is typically used in conjunction with a coverage upload action. Here's a complete example:

```yaml
name: Coverage Check

on:
  pull_request:
    branches: [master]

jobs:
  # First job: Run tests and upload coverage
  test-upload-coverage:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']

    steps:
      - uses: actions/checkout@v3

      # Run your tests and generate coverage
      - name: Generate coverage report
        run: |
          pip install coverage
          coverage run -m unittest discover
          coverage report -m
          coverage xml

      # Upload the coverage report
      - name: Upload coverage
        uses: baobabsoluciones/upload-coverage@v0.0.15
        with:
          python-version: ${{ matrix.python-version }}
          gcp-project-id: ${{ secrets.GCP_PROJECT_ID }}
          gcp-credentials: ${{ secrets.GCP_CREDENTIALS }}
          gcp-coverage-bucket: ${{ secrets.GCP_COVERAGE_BUCKET }}

  # Second job: Compare coverage
  coverage-check:
    needs: test-upload-coverage
    runs-on: ubuntu-latest
    steps:
      - uses: baobab-soluciones/coverage-action@v1
        with:
          gcp_credentials: ${{ secrets.GCP_CREDENTIALS }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          gcp_bucket: ${{ secrets.GCP_COVERAGE_BUCKET }}
          min_coverage: '80'
          show_missing_lines: 'true'
```

## Inputs

| Input                | Description                                       | Required | Default |
| -------------------- | ------------------------------------------------- | -------- | ------- |
| `gcp_credentials`    | Google Cloud Service Account credentials JSON     | Yes      | -       |
| `github_token`       | GitHub token for PR comments                      | Yes      | -       |
| `gcp_bucket`         | GCP bucket name where coverage reports are stored | Yes      | -       |
| `min_coverage`       | Minimum required coverage percentage              | No       | 80      |
| `show_missing_lines` | Show missing lines in coverage report             | No       | false   |

## Coverage Report Format

The action expects coverage reports to be stored in Google Cloud Storage with the following structure:

```
bucket/
└── repository-name/
    └── branch-name/
        └── timestamp/
            └── coverage.xml
```

### Path Handling

The action automatically normalizes paths between PR changes and coverage reports. For example, if your PR shows changes in:

```
python_coverage/module/example.py
```

But your coverage report has paths like:

```
module/example.py
```

The action will automatically match these files by removing common prefixes (like `python_coverage/`). This ensures accurate coverage tracking regardless of path differences between your PR and coverage reports.

## Output Example

The action will create or update a comment in your PR that looks like this:

```diff
@@ Coverage Diff @@
## main    #feature    +/-  ##
===========================================
  Coverage     85.00%    87.50%    +2.50% 📈
===========================================
  Files            10        11        +1
  Lines           200       220       +20
  Branches         50        55        +5
===========================================
  Hits            170       192       +22 📈
  Misses           25        23        -2 📈
  Partials          5         5         0 📈

@@ File Coverage Diff @@
  src/index.js     80.00%    85.00%    +5.00% 📈
- src/utils.js     90.00%    85.00%    -5.00% 📉
+ src/new-file.js   0.00%    75.00%   +75.00% 📈
```

## Requirements

- Coverage reports must be in XML format (Cobertura format)
- Coverage reports must be stored in Google Cloud Storage
- The action must be run on pull request events
- GCP credentials with read access to the storage bucket
- GitHub token with permissions to comment on PRs

## License

This project is licensed under the Apache 2.0 License - see the LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
