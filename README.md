# Zappy's Bruce Trail side trails

A free website (GitHub Pages) that tracks Zappy's progress through every dog-friendly Bruce Trail side trail.

- **Map:** every planned hike is a numbered dot at its parking. Click one for the guide, route map, GPX and turn-by-turn directions. Side trails turn green once a GPS track shows Zappy walked them.
- **List:** all 106 hikes in day order, with filters for to do, started and done.
- **Upload:** drop the Gaia GPS track and the photos from a hike. A GitHub Action then:
  1. matches the track to the planned side trails and marks them walked, with the date;
  2. reads each photo's date and location, or places it on the track by the time it was taken if the phone stripped the location;
  3. makes web-sized copies of the photos with their metadata removed;
  4. republishes the site.

## One-time setup

1. Push this folder to a new **public** repository (for example `awreinke/zappy-bruce-trail`).
2. In the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Go to **Actions → "Process uploads and publish site" → Run workflow**.
   - The site appears at `https://<user>.github.io/<repo>/` after about a minute.
4. Create the upload token:
   - Open the site's **Upload** page and follow the "one-time setup" steps there.
   - Make a fine-grained token limited to this repository, with **Contents: read and write** and **Actions: read**.

## Adding a hike

Choose either:

- **On the site:** open the **Upload** page, then drop in the `.gpx` and the photos, from a phone or a computer.
- **On github.com:** open the `uploads/` folder, choose **Add file → Upload files**, then commit.

Several hikes can go up at once. Uploading the same file twice is detected and skipped. Photos uploaded before their GPX are placed once the GPX arrives.

### Hikes done before you started tracking

Add them to `data/manual.json`:

```json
{ "hikes": { "41": "2026-08-15" } }
```

The key is the hike number and the value is the date. Every planned side trail of that hike then counts as walked.

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | Map, hike panel and list |
| `upload.html`, `upload.js` | Upload page (commits to `uploads/` through the GitHub API) |
| `scripts/process_uploads.py` | Track matching and photo processing |
| `.github/workflows/build.yml` | Runs the processing, then deploys Pages |
| `data/hikes.json`, `routes.geojson`, `side_trails.json`, `main_trail.json` | The plan |
| `data/progress.json`, `data/tracks/`, `photos/` | Zappy's progress, written by the Action |
| `guides/hikeNNN/` | PDF guide, route map and GPX for each hike |

Trail data: Bruce Trail Conservancy, via Bruce County GIS. Maps: © OpenStreetMap contributors, OpenTopoMap and Esri. Always check the Conservancy's trail-change notices before a hike.
