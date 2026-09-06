import { dag, Directory, object, func } from "@dagger.io/dagger"

const SEMGREP_IMAGE = "docker.io/semgrep/semgrep@sha256:6bd07d7b166b097e1384f41b94a62d8c8a26a4fff8713992c296e053310da01f"
const ALINT_IMAGE = "ghcr.io/asamarts/alint:v0.15.0@sha256:e7e7631979741a9b2fdcde106ee8c57513ec2b02a317dcc91614f435c89798ca"
const NODE_IMAGE = "node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584"
// The approved execution image includes the sealed Playwright/Chromium pair.
// Registry authentication belongs to the operator's Dagger client, not the app.
const APPLICATION_TEST_IMAGE = "ghcr.io/firstartifacthq/reddit-qa-execution@sha256:507836265d75817d6463538211a832318994ad5753198866693bd0537b819325"
const LS_LINT_URL = "https://github.com/loeffel-io/ls-lint/releases/download/v2.3.1/ls-lint-linux-amd64"
const LS_LINT_SHA256 = "b5a0d2e4427ad039fbc574551f17679f38f142b25d15e0e538769f8cf15af397"
const SEMGREP_RULE = ".semgrep/software-factory-anti-slop.yml"
const SEMGREP_TEST = ".semgrep/software-factory-anti-slop.ts"

@object()
export class Qualification {
  @func()
  async semgrep(source: Directory): Promise<string> {
    const repository = source.withoutDirectory(".crabbox").withoutDirectory(".devenv")
    return dag.container()
      .from(SEMGREP_IMAGE)
      .withMountedDirectory("/src", repository)
      .withWorkdir("/src")
      .withExec(["semgrep", "--test", "--config", SEMGREP_RULE, SEMGREP_TEST])
      .withExec([
        "semgrep", "scan", "--error",
        "--config", SEMGREP_RULE,
        "--exclude", SEMGREP_TEST,
        ".",
      ])
      .stdout()
  }

  @func()
  async alint(source: Directory): Promise<string> {
    const repository = source.withoutDirectory(".crabbox").withoutDirectory(".devenv")
    return dag.container()
      .from(ALINT_IMAGE)
      .withEntrypoint([])
      .withMountedDirectory("/src", repository)
      .withWorkdir("/src")
      .withExec(["alint", "check", "--fail-on-warning", "."])
      .stdout()
  }

  @func()
  async lsLint(source: Directory): Promise<string> {
    const repository = source.withoutDirectory(".crabbox").withoutDirectory(".devenv")
    return dag.container()
      .from(NODE_IMAGE)
      .withMountedDirectory("/src", repository)
      .withWorkdir("/src")
      .withFile("/usr/local/bin/ls-lint", dag.http(LS_LINT_URL), { permissions: 0o755 })
      .withExec(["sh", "-ceu", `echo "${LS_LINT_SHA256}  /usr/local/bin/ls-lint" | sha256sum -c -`])
      .withExec(["/usr/local/bin/ls-lint"])
      .stdout()
  }

  @func()
  async applicationTypecheck(source: Directory): Promise<string> {
    const repository = source.withoutDirectory(".crabbox").withoutDirectory(".devenv")
    return dag.container()
      .from(NODE_IMAGE)
      .withMountedDirectory("/src", repository)
      .withWorkdir("/src")
      .withExec(["npm", "ci"])
      .withExec(["npm", "run", "typecheck"])
      .stdout()
  }

  @func()
  async applicationTest(source: Directory): Promise<string> {
    const repository = source.withoutDirectory(".crabbox").withoutDirectory(".devenv")
    return dag.container()
      .from(APPLICATION_TEST_IMAGE)
      .withDirectory("/src", repository, { owner: "1000:1000" })
      .withWorkdir("/src")
      // Permission-loss fixtures must exercise a process subject to mode bits.
      .withUser("1000:1000")
      .withExec(["npm", "ci"])
      .withExec(["npm", "test"])
      .stdout()
  }

  @func()
  async qualification(source: Directory): Promise<string> {
    const semgrep = await this.semgrep(source)
    const alint = await this.alint(source)
    const lsLint = await this.lsLint(source)
    const typecheck = await this.applicationTypecheck(source)
    const test = await this.applicationTest(source)
    return [semgrep, alint, lsLint, typecheck, test].filter(Boolean).join("\n")
  }
}
