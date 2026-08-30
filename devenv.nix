{ pkgs, ... }:

let
  system = pkgs.stdenv.hostPlatform.system;
  dagger = pkgs.stdenvNoCC.mkDerivation {
    pname = "dagger";
    version = "0.21.8";
    src = pkgs.fetchurl {
      url = {
        x86_64-linux = "https://github.com/dagger/dagger/releases/download/v0.21.8/dagger_v0.21.8_linux_amd64.tar.gz";
        aarch64-linux = "https://github.com/dagger/dagger/releases/download/v0.21.8/dagger_v0.21.8_linux_arm64.tar.gz";
      }.${system} or (throw "dagger 0.21.8 does not support ${system}");
      hash = {
        x86_64-linux = "sha256-U+Imx9qPt1Fx5Yw1dZ1zbZYc6LOhLbC6p7cQeVT8zFo=";
        aarch64-linux = "sha256-zQ30iF8gUAgpMrSrxaaq2acz9qpOfYR0dAVYUX/+xK8=";
      }.${system} or (throw "dagger 0.21.8 has no hash for ${system}");
    };
    sourceRoot = ".";
    installPhase = ''
      runHook preInstall
      install -Dm755 dagger "$out/bin/dagger"
      runHook postInstall
    '';
  };
in
{
  packages = [ dagger ];
}
