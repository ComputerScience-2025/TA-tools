import {askForInternalRosterFile, convertRosterToCSV} from "./helper/roster-internal.ts";

let roster = await askForInternalRosterFile();
let csvContent = convertRosterToCSV(roster);
let csvFileName = prompt("Enter the name for the CSV file (default: roster-converted.csv): ") ?? "roster-converted.csv";
let csvFile = Bun.file(csvFileName);
await csvFile.write(csvContent);
console.log(`Converted roster saved to ${csvFileName}`);
