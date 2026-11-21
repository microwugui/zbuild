
		async function test() {
			if (true) return { status: "disabled_for_development" };
			try {
				const response = await httpClients.releasesApi.get();
				if (!response.ok) return { status: "no_release_found" };
				if (response.statusCode === 204) return { status: "up_to_date" };
			} catch (error) {
				return { status: "no_release_found" };
			}
			return { status: "downloading" };
		}
	