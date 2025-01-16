export const CanvasHelper = {
    parseSubmissionFilename: (filename: string) => {
        let split = filename.split("_");
        return {
            personName: split[0],
            personID: split[1],
            fileID: split[2],
            actualFilename: split.slice(3).join("_"),
        }
    }
};
