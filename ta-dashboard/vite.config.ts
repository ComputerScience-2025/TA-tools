import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Packages the browser EPF graph imports, installed here because `$epf` points
// at ../even-playingfield/src, outside this project root. Vite resolves a bare
// import next to the importing file, so without this list it looks for them in
// even-playingfield/node_modules, which only exists after a separate install.
const EPF_RUNTIME_DEPS = [
	'@zenfs/core',
	'@zenfs/dom',
	'picomatch',
	'smol-toml',
	'zod',
	'zod-defaults',
	'ai',
	'@ai-sdk/openai',
	'@ai-sdk/anthropic',
	'@ai-sdk/google',
	'@aws-sdk/client-s3',
	'@smithy/fetch-http-handler'
];

export default defineConfig({
	plugins: [sveltekit()],
	// Resolve EPF's dependencies from this package instead of the sibling's.
	resolve: {
		dedupe: EPF_RUNTIME_DEPS
	},
	// These are only reached through dynamic imports (the console loads xterm on
	// demand, the EPF session loads the core on demand). Declaring them keeps the
	// dev-server optimizer from re-bundling mid-session.
	optimizeDeps: {
		include: [
			...EPF_RUNTIME_DEPS,
			'@xterm/xterm',
			'@xterm/addon-fit',
			'xterm-readline'
		]
	},
	server: {
		fs: {
			// $epf resolves into ../even-playingfield/src, outside this project root.
			allow: ['..']
		}
	}
});
