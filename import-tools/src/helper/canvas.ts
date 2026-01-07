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
        // turn the filename from "ABC-1.cs" to "ABC.cs"
        if (/\w+-\d\.((cs)|(cpp)|(h))$/gm.test(originalName)) {
            return originalName.replace(/-\d\./, ".");
        }
        
        return originalName;
    },
};
