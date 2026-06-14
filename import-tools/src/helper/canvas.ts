export const CanvasHelper = {
    parseSubmissionFilename: (filename: string) => {
        let normalizedName = filename.replace("_LATE_", "_");
        let split = normalizedName.split("_");
        return {
            personName: split[0],
            personID: split[1],
            fileID: split[2],
            actualFilename: split.slice(3).join("_"),
        }
    },
    recreateSubmissionFilename: (parsed: {personName: string, personID: string, fileID: string, actualFilename: string}) => {
        return `${parsed.personName}_${parsed.personID}_${parsed.fileID}_${parsed.actualFilename}`;
    },
    fixFileName: (originalName: string) => {
        // Strip UUID suffix: "UnitTest1-80a8d60a-75b2-4fda-a291-b72a36395bd9.cs" -> "UnitTest1.cs"
        if (/\w+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(cs|cpp|h)$/i.test(originalName)) {
            return originalName.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\./i, ".");
        }

        // Strip numeric suffix: "ABC-1.cs" -> "ABC.cs"
        if (/\w+-\d+\.(cs|cpp|h)$/i.test(originalName)) {
            return originalName.replace(/-\d+\./i, ".");
        }
        
        return originalName;
    },
};
