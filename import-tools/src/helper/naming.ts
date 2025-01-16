export const Naming = {
    /*
    * Make a repository name from course name, section name, and person name
    * DO NOT CHANGE
    * */
    makeRepositoryName: (_: {courseName: string, sectionName: string, personName: string}) => {
      return `${_.courseName}.${_.sectionName}.${_.personName}`;
    },
}
