<script lang="ts">
	import { page } from "$app/state";

	import { EPF_HREFS } from "$lib/epf/routes.ts";
</script>

<article class="message is-danger">
	<div class="message-header"><p>This EPF page could not load</p></div>
	<div class="message-body">
		<p class="mb-2">
			<strong>{page.status}</strong>
			{page.error?.message ?? "Unknown error"}
		</p>
		<a class="button is-small" href={EPF_HREFS.source}>Back to Source</a>
	</div>
</article>
