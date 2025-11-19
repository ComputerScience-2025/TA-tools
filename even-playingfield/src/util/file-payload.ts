/**
 * Helper class for generating file content payloads with language-specific formatting
 */
export class FilePayloadGenerator {
    private static readonly LANGUAGE_MAP: Record<string, string> = {
        '.cs': 'csharp',
        '.cpp': 'cpp',
        '.cc': 'cpp',
        '.cxx': 'cpp',
        '.c': 'c',
        '.h': 'cpp',
        '.hpp': 'cpp',
        '.hxx': 'cpp',
        '.java': 'java',
        '.js': 'javascript',
        '.ts': 'typescript',
        '.py': 'python',
        '.rb': 'ruby',
        '.go': 'go',
        '.rs': 'rust',
        '.swift': 'swift',
        '.kt': 'kotlin',
        '.php': 'php',
        '.scala': 'scala',
        '.sh': 'bash',
        '.bash': 'bash',
        '.zsh': 'zsh',
        '.ps1': 'powershell',
        '.md': 'markdown',
        '.json': 'json',
        '.xml': 'xml',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.toml': 'toml',
        '.html': 'html',
        '.css': 'css',
        '.scss': 'scss',
        '.sql': 'sql',
    };

    /**
     * Get the language identifier for a file based on its extension
     * @param filePath The path to the file
     * @returns The language identifier (e.g., 'csharp', 'cpp')
     */
    private static getLanguageFromPath(filePath: string): string {
        const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
        return this.LANGUAGE_MAP[ext] || 'text';
    }

    /**
     * Generate a formatted payload for a single file
     * @param filePath The path to the file
     * @param content The content of the file
     * @returns A formatted string with file path and content in a code block
     */
    static formatFileContent(filePath: string, content: string): string {
        const language = this.getLanguageFromPath(filePath);
        return `${filePath}\n\`\`\`${language}\n${content}\n\`\`\``;
    }

    /**
     * Generate payloads for multiple files
     * @param files Array of file paths
     * @returns Array of formatted file content strings
     */
    static async generatePayloads(files: string[]): Promise<string[]> {
        const payloads: string[] = [];
        
        for (const file of files) {
            const content = await Bun.file(file).text();
            payloads.push(this.formatFileContent(file, content));
        }
        
        return payloads;
    }

    /**
     * Add a custom language mapping
     * @param extension The file extension (including the dot, e.g., '.custom')
     * @param language The language identifier to use
     */
    static addLanguageMapping(extension: string, language: string): void {
        this.LANGUAGE_MAP[extension.toLowerCase()] = language;
    }
}

