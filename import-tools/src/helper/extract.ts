export function extractNameFromParts(name: string){
    if (name.includes(",")) {
        let split = name.split(",");
        if (split.length !== 2) {
            throw new Error(`Invalid name format: "${name}"`);
        }
        return `${split[1].trim()} ${split[0].trim()}`;
    }
    else {
        return name;
    }
}

export function extractUserNameFromEmail(email: string) {
    if (email.includes("@")) {
        return email.split("@")[0];
    }
    else {
        return email;
    }
}
