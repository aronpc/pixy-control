-- Câmera via portal para apps do host (não-flatpak).
-- Com pipewire 1.0.5 + xdg-desktop-portal 1.18 a conexão que o portal abre para a
-- câmera chega como pipewire.access=unrestricted, mas com permissão padrão zerada;
-- o access-portal.lua só trata pipewire.access=portal, então ninguém libera as
-- câmeras e o Chromium (Electron, Chrome com WebRtcPipeWireCamera) vê zero devices
-- ("Requested device not found"). Apps do host já podem abrir /dev/video direto,
-- então dar leitura a eles não abre nada novo. Usado pelo PIXY Control.
table.insert(default_access.rules, {
  matches = {
    {
      { "pipewire.access", "=", "unrestricted" },
      { "pipewire.access.portal.media_roles", "=", "Camera" },
    },
  },
  default_permissions = "rx",
})
