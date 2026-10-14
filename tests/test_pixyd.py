"""Testes do helper sem a câmera: protocolo HID, nomes V4L2, modos e a resposta ao app."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "helper"))
import pixyd  # noqa: E402


class Frames(unittest.TestCase):
    def test_consulta_e_so_o_head(self):
        self.assertEqual(pixyd.frame(pixyd.GET_MODE), [0x09, 0x01, 0x01, 0x01])

    def test_set_leva_tamanho_duas_vezes_e_payload(self):
        self.assertEqual(pixyd.frame(pixyd.SET_MODE, [0x02]), [0x09, 0x01, 0x01, 0x00, 0, 1, 0, 1, 0x02])

    def test_relatorio_completado_com_zeros_ate_32(self):
        data = pixyd.check_report(pixyd.frame(pixyd.SET_AUDIO, [0x01]))
        self.assertEqual(len(data), 32)
        self.assertEqual(data[9:], bytes(23))


class ComandosProibidos(unittest.TestCase):
    def assertRecusa(self, report):
        with self.assertRaises(PermissionError):
            pixyd.check_report(report)

    def test_factory_reset(self):
        self.assertRecusa([0x09, 0x01, 0x00, 0x05])

    def test_grupo_de_energia(self):
        self.assertRecusa([0x09, 0x00, 0x00, 0x02])

    def test_firmware_e_sd(self):
        self.assertRecusa([0x09, 0x09, 0x00, 0x00])
        self.assertRecusa([0x09, 0x0A, 0x00, 0x00])

    def test_so_relatorio_09(self):
        self.assertRecusa([0x07, 0x01, 0x01, 0x00])

    def test_grupo_compara_com_mascara_0x1f(self):
        # o MCU do motor responde como 0x63; 0x63 & 0x1f = 3 (motor), permitido
        pixyd.check_report([0x09, 0x63, 0x01, 0x02])
        # 0x20 | 0x00 cai no grupo de energia depois da máscara
        self.assertRecusa([0x09, 0x20, 0x00, 0x02])

    def test_maior_que_32_bytes(self):
        with self.assertRaises(ValueError):
            pixyd.check_report([0x09] * 33)


class Nomes(unittest.TestCase):
    def test_snake(self):
        self.assertEqual(pixyd.snake("White Balance, Automatic"), "white_balance_automatic")
        self.assertEqual(pixyd.snake("Pan (Absolute)"), "pan_absolute")

    def test_nome_reverso(self):
        self.assertEqual(pixyd._name(pixyd.AUDIO, 0x02), "live")
        self.assertIsNone(pixyd._name(pixyd.AUDIO, 0x09))


ENUM_FORMAT = """
  Object: size 128, type Spa:Pod:Object:Param:Format (262147), id Spa:Enum:ParamId:EnumFormat (3)
    Prop: key Spa:Pod:Object:Param:Format:mediaSubtype (2), flags 00000000
      Id 131074    (Spa:Enum:MediaSubtype:mjpg)
    Prop: key Spa:Pod:Object:Param:Format:Video:size (131075), flags 00000000
      Rectangle 1280x720
    Prop: key Spa:Pod:Object:Param:Format:Video:framerate (131076), flags 00000000
      Choice: type Spa:Enum:Choice:Enum, flags 00000000
        Fraction 60/1
        Fraction 60/1
        Fraction 30/1
  Object: size 128, type Spa:Pod:Object:Param:Format (262147), id Spa:Enum:ParamId:EnumFormat (3)
    Prop: key Spa:Pod:Object:Param:Format:mediaSubtype (2), flags 00000000
      Id 1    (Spa:Enum:MediaSubtype:raw)
    Prop: key Spa:Pod:Object:Param:Format:Video:size (131075), flags 00000000
      Rectangle 640x480
  Object: size 128, type Spa:Pod:Object:Param:Format (262147), id Spa:Enum:ParamId:EnumFormat (3)
    Prop: key Spa:Pod:Object:Param:Format:mediaSubtype (2), flags 00000000
      Id 131074    (Spa:Enum:MediaSubtype:mjpg)
    Prop: key Spa:Pod:Object:Param:Format:Video:size (131075), flags 00000000
      Rectangle 3840x2160
    Prop: key Spa:Pod:Object:Param:Format:Video:framerate (131076), flags 00000000
        Fraction 30/1
"""


class Modos(unittest.TestCase):
    def test_so_mjpeg_do_maior_ao_menor(self):
        self.assertEqual(pixyd.parse_enum_format(ENUM_FORMAT), [
            {"width": 3840, "height": 2160, "fps": [30]},
            {"width": 1280, "height": 720, "fps": [60, 30]},
        ])

    def test_saida_vazia(self):
        self.assertEqual(pixyd.parse_enum_format(""), [])


class Resposta(unittest.TestCase):
    def test_id_da_requisicao_vence_id_do_dado(self):
        # regressão: o status trazia "id" do device e o app nunca casava a resposta
        res = pixyd.response({"id": 7, "op": "status"}, {"id": "3-80:video5:1", "video": "/dev/video5"})
        self.assertEqual(res["id"], 7)
        self.assertTrue(res["ok"])
        self.assertEqual(res["video"], "/dev/video5")


if __name__ == "__main__":
    unittest.main()
