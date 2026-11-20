# Source Builder

The source builder adds a data source without writing code and without AI. You
answer a few questions, check a preview of the table, and the source is
installed and refreshed on its schedule. It works for sources that publish a
table of data: a spreadsheet, a dataset, a map layer, a web service, a file you
have, or a system that sends data.

Editors and admins can build sources. Viewers can look at the results.

## Starting

Open **Integrations** and choose **New source** (or the New source card on the
home page). Your work is saved at every step. If you leave, open the same page
again and carry on where you were. A draft nobody touches for 24 hours is
removed.

## The steps

**1. Source.** Give the source a name and choose the kind of source. The six
kinds are:

- **Spreadsheet or CSV at a link.** A CSV or Excel file that has a web address
  and can be downloaded without signing in.
- **HDX dataset.** A file in a dataset on the Humanitarian Data Exchange. You
  give the dataset page address and the resource id of the file.
- **ArcGIS map layer.** A feature layer published by an ArcGIS server. You give
  the layer address.
- **Web service (API).** A web address that answers with JSON. You can say
  where the list of records sits in the answer. Some services need a key (see
  "Keys" below).
- **Uploaded file.** A CSV or Excel file you upload from your computer. Upload
  a new version later and the source refreshes.
- **Data sent by a device or system.** The source gives you an address, and the
  other system posts messages to it. You paste a sample message so the builder
  can see the fields.

Links are checked before anything is read: addresses that point inside the
server's own network are refused. When you choose Next, the builder reads the
source once to find its columns.

**2. Columns.** Tick the columns you want and give each a type: text, number,
date, or place. Names of columns become the table's column names (lowercase
letters, digits and underscores). Choose the column that identifies each row if
the source asks for one.

**3. Clean-up (optional).** For files with a title above the table, set how
many rows to skip and which row holds the column names. Keep only rows that
match a filter. If the dates are spread across columns (one column per month,
for example), choose them to unpivot: the table then gets one row per place and
date, with a date column and a value column.

**4. Places.** If a column holds place names, match them to a places table that
is already in WASH Data Integrator (for example administrative regions). Exact
matches are chosen for you. Close matches are offered but never chosen without
you. Any name can be left unmatched. The table gets an extra column with the
place code.

**5. Preview.** The builder runs the source once into a scratch area and shows
the first rows, how many places matched, and any values that did not fit their
type. Nothing is installed yet.

**6. Name and schedule.** Check the name and the table name (it cannot change
later), choose how often the source refreshes, and say who publishes the data,
its licence and its limitations. Times are in UTC. "Manual only" means the
source refreshes only when someone starts it.

**7. Add.** A summary, then **Add this source**. The source is installed and
its first run starts. For a source that receives data from a device or system,
the page shows the address to give the other system, and a test command.

## Keys

Some web services need a key. Only an admin can add a key; the builder shows
"Waiting for an admin to add the key" until one does. The key is stored
encrypted and is never shown again or put into a library entry. A source that
needs a key cannot be added until the key is in.

- A key is only sent over **https**: a web address starting with `http://` is
  refused for a source that needs a key.
- A key is tied to the web address it was added for (its scheme, host and
  port). If the address is later changed to another host, port or to `http`,
  the key is removed and an admin has to add it again. This applies to a key an
  admin added and to the key copied when you edit an installed source. Other
  changes to the address on the same host, such as a different path, keep it.
- The key is never sent to another host: a redirect to another host or to
  `http` stops the run with an error, and a next-page link on another host is
  read without the key.

## Data sent by a device or system

Readings get the time they are processed, not the time the device measured
them. A device that needs exact times should send its own timestamp field, and
the builder keeps it as a date column.

## After the source is added

On the source's page:

- **Fix matches** appears when the last run could not match some place names.
  It lists the names and opens the builder at the Places step.
- **Edit in builder** opens the source's settings again. Saving at the last
  step updates the source (a new version). The schedule, area of interest and
  other settings of the source are kept. The kind of source and the table name
  cannot change.
- **Update available** appears when the connector the source uses has a newer
  version. Nothing changes until you choose **Update the connector**.
- If the source has no schedule yet, the page says so and links to the schedule
  settings.

## Sharing through the library

A source made here can be offered to the whole deployment:

1. On the source's page, an editor or admin chooses **Propose for library**.
2. An admin reviews it in the **Library**, where it shows as "Waiting for
   approval", and chooses **Approve** or **Reject** (with an optional reason).
3. Approved entries show as **Built here**; entries that ship with the product
   show as **Shipped**. Anyone who can edit can install a built entry. A fresh
   install has no schedule (the schedule belongs to the deployment): the page
   says "This source has no schedule yet" and links to the schedule settings.
   A source that takes pushed data is the exception, since it runs when data
   arrives.
4. If you change a source that is already in the library and propose it again,
   the new version waits for approval and the approved one stays in use.
5. When a new version is approved, every installed copy that was not changed
   locally shows **Update available** in the Library. Updating installs the
   new version's settings and keeps the copy's schedule, area of interest,
   limits, setting values and key. A copy that was changed locally shows
   **Changed here** instead and keeps its own settings.

A library entry holds the recipe (the settings from the steps), never code, keys,
the area of interest or the schedule. When an entry is installed or imported,
its table, inputs and other technical parts are rebuilt from the recipe, so
only the name, description and source information come from the entry itself.

### Export and import

An approved built entry can be exported (**Export**) as `<id>.wash-di.json` and
imported into another deployment by an admin (**Import entry** in the Library).
An imported entry waits for approval like any proposal. Files that contain code
are refused.

## Limits

- One table per source.
- A source with a place column needs the places table to exist before you add it.
- Source files and responses are read in full, so very large sources are better
  served by a hand-written integration.
