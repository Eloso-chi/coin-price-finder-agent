# Terapeak Sold Data

Drop your Terapeak CSV exports in this folder. They'll be auto-imported on server startup.

## How to get the data

1. Go to [eBay Seller Hub → Research](https://www.ebay.com/sh/research) (Terapeak)
2. Search for a coin (e.g. "1892-S Morgan Silver Dollar")
3. Set filters: Sold Items, date range, condition, etc.
4. Click **Export** to download the CSV
5. Rename the file to match the search term: `1892-S_Morgan_Silver_Dollar.csv`
6. Drop it in this folder
7. Restart the server (or upload via the Sold Data tab in the UI)

## File naming

The filename (without extension) becomes the search term used for matching:
- `1892-S_Morgan_Silver_Dollar.csv` → search term: "1892-S Morgan Silver Dollar"
- Underscores are converted to spaces automatically

**Optional:** Create a `.meta` file with the same name to specify a custom search term:
- `morgan_1892s.meta` containing: `1892-S Morgan Silver Dollar`

## Update schedule

Terapeak data is relatively static — **monthly updates** are sufficient.
Just replace the CSV files and restart the server. Duplicate items are automatically skipped.
