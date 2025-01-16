import requests

confirm = input("Are you sure you want to delete all repositories in the organization? (yes/no): ")
if confirm != "yes":
    print("Exiting...")
    exit()

# GitHub API URL
api_url = "https://api.github.com"
# Organization name (change to your organization)
organization = input("Enter your organization name: ")
# Your personal access token
token = input("Enter your personal access token: ")

# Get the list of repositories for the organization
response = requests.get(
    f"{api_url}/orgs/{organization}/repos?per_page=100",
    headers={"Authorization": f"token {token}"}
)

if response.status_code == 200:
    repos = response.json()
    for repo in repos:
        repo_name = repo["name"]
        # Delete the repository
        delete_response = requests.delete(
            f"{api_url}/repos/{organization}/{repo_name}",
            headers={"Authorization": f"token {token}"}
        )
        if delete_response.status_code == 204:
            print(f"Successfully deleted {repo_name}")
        else:
            print(f"Failed to delete {repo_name}: {delete_response.status_code}")
else:
    print(f"Failed to fetch repositories: {response.status_code}")

