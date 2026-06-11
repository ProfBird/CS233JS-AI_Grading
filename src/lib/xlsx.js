// Shared SheetJS entry point. The xlsx ESM build does not auto-wire Node's fs the
// way the CommonJS build did, so readFile/writeFile throw "cannot access file"
// until set_fs() is called. Import xlsx from here (not directly from 'xlsx') so
// the fs binding is guaranteed to be wired before any disk I/O. xlsx is a
// singleton, so wiring it once here covers every importer.
import * as XLSX from 'xlsx';
import fs from 'fs';

XLSX.set_fs(fs);

export default XLSX;
