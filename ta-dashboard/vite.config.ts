import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// These are only reached through dynamic imports (the console loads xterm on
	// demand, the EPF session loads the core on demand). Declaring them keeps the
	// dev-server optimizer from re-bundling mid-session.
	optimizeDeps: {
		include: [
			'@xterm/xterm',
			'@xterm/addon-fit',
			'xterm-readline',
			'@zenfs/core',
			'@zenfs/dom',
			'picomatch',
			'smol-toml',
			'zod',
			'ai',
			'@ai-sdk/openai',
			'@ai-sdk/anthropic',
			'@ai-sdk/google'
		]
	},
	server: {
		fs: {
			// $epf resolves into ../even-playingfield/src, outside this project root.
			allow: ['..']
		}
	}
});
