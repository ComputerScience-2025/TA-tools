type RepositoryNamePayload = {courseName: string, sectionName: string, personName: string, personID: string}

export const Naming = {
    /*
    * Make a repository name from course name, section name, and person name
    * DO NOT CHANGE
    * */
    repositoryNamePrefix: (_: {courseName: string, sectionName: string}) => {
        return `${_.courseName}.${_.sectionName}`;
    },
    makeRepositoryName: (_: RepositoryNamePayload) => {
      return `${Naming.repositoryNamePrefix(_)}.${_.personID}.${_.personName}`;
    },
    parseRepositoryName: (_: string): RepositoryNamePayload => {
        let parts = _.split(".");
        return {
            courseName: parts[0],
            sectionName: parts[1],
            personID: parts[2],
            personName: parts[3],
        }
    }
}
