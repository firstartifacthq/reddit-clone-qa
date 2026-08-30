import { dag, Directory, object, func } from "@dagger.io/dagger"

const SEMGREP_IMAGE = "docker.io/semgrep/semgrep@sha256:6bd07d7b166b097e1384f41b94a62d8c8a26a4fff8713992c296e053310da01f"
const ALINT_IMAGE = "ghcr.io/asamarts/alint:v0.15.0@sha256:e7e7631979741a9b2fdcde106ee8c57513ec2b02a317dcc91614f435c89798ca"
const NODE_IMAGE = "node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584"
const LS_LINT_URL = "https://github.com/loeffel-io/ls-lint/releases/download/v2.3.1/ls-lint-linux-amd64"
const LS_LINT_SHA256 = "b5a0d2e4427ad039fbc574551f17679f38f142b25d15e0e538769f8cf15af397"

@object()
export class Qualification {
  @func()
  async semgrep(source: Directory): Promise<string> {
    const repository = source.withoutDirectory(".crabbox").withoutDirectory(".devenv")
    return dag.container()
      .from(SEMGREP_IMAGE)
      .withMountedDirectory("/src", repository)
      .withWorkdir("/src")
      .withExec(["semgrep", "--test", ".semgrep"])
      .withExec([
        "semgrep", "scan", "--error",
        "--config", ".semgrep/software-factory-anti-slop.yml",
        "--exclude", ".semgrep/software-factory-anti-slop.ts",
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
  async qualification(source: Directory): Promise<string> {
    const semgrep = await this.semgrep(source)
    const alint = await this.alint(source)
    const lsLint = await this.lsLint(source)
    return [semgrep, alint, lsLint].filter(Boolean).join("\n")
  }
}
