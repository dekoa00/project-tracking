# Project Tracking on GitHub Actions

This version lets GitHub Actions run the tracking bot online without Excel.

## Input format

Edit `data/input.tsv` in GitHub and paste rows from Excel/Google Sheets.
The first row must contain headers.

Required columns:

```tsv
TRACKING NUMBER	CARRIER
MEDUR7589829	MSC
039GX40031	WHL
```

Optional columns:

```tsv
BKG	BL NO.	NOTE
```

Ignored carriers:

```text
VESSEL
0
```

## Run manually

1. Go to your GitHub repo.
2. Open **Actions**.
3. Choose **Project Tracking**.
4. Click **Run workflow**.

## Daily run

The workflow also runs daily at 07:30 Vietnam time:

```yaml
cron: "30 0 * * *"
```

GitHub cron uses UTC.

## Output

After each run, results are saved to:

```text
data/results/latest.json
data/results/latest.tsv
data/results/latest.csv
```

They are also uploaded as a workflow artifact named `project-tracking-result`.

## Important notes

- Playwright carriers run in headless Chromium on Ubuntu.
- CMA/RCL Selenium carriers install Python 3.11 + Selenium + undetected-chromedriver during the workflow.
- Cloud runners use datacenter IPs, so some carrier sites may show CAPTCHA or block. If a carrier fails online but works locally, this is likely why.
- Do not commit private credentials/cookies. Put secrets in GitHub **Settings → Secrets and variables → Actions** if needed later.

## Static Dashboard

This package now includes `index.html` at the repo root. It can be served by GitHub Pages and used as a lightweight dashboard:

- Paste shipment rows from Excel/Google Sheets.
- Preview parsed rows.
- Trigger `.github/workflows/project-tracking.yml` through `workflow_dispatch`.
- Read and render `data/results/latest.json` as a result table.

### Recommended GitHub Pages setup

1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Set source to **Deploy from a branch**.
4. Choose branch `main` and folder `/root`.
5. Open the Pages URL and configure owner/repo/branch/token in the dashboard.

### Token note

For private repos or the **Run Tracking** button, create a fine-grained GitHub token for this repo only. Grant:

- Actions: Read and write
- Contents: Read and write

The token is used in your browser only. Save it locally only on a trusted machine.
