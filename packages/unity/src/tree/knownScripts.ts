/*
 * よく使われるパッケージのコンポーネント（MonoBehaviour）の既知表（2026-10-03、利用者の指示）。
 *
 * uGUI（`com.unity.ugui`）・TextMeshPro・EventSystem などはパッケージの `.cs` で定義されていて、
 * `.meta` はリポジトリではなく `Library/PackageCache` にある。走査しなくても名前を出せるよう、
 * guid の固定値をここに持つ（Unity はパッケージのスクリプトの guid を版をまたいで変えない）。
 *
 * **索引（走査の結果）が見つけた名前のほうを優先する**（build.ts の displayName）。
 * ここは「走査していない・Library が無い（Unity で開いたことのないクローン）」ときの代わり。
 * 載せるのは guid に確信のあるものだけにする。誤った guid は単に一致しないだけで害は無いが、
 * 別のクラスに名前を付け違えると読み手を誤らせる。
 */

export const KNOWN_SCRIPT_NAMES: ReadonlyMap<string, string> = new Map([
  // uGUI（com.unity.ugui）
  ['5f7201a12d95ffc409449d95f23cf332', 'Text'],
  ['fe87c0e1cc204ed48ad3b37840f39efc', 'Image'],
  ['1344c3c82d62a2a41a3576d8abb8e3ea', 'RawImage'],
  ['4e29b1a8efbd4b44bb3f3716e73f07ff', 'Button'],
  ['9085046f02f69544eb97fd06b6048fe2', 'Toggle'],
  ['67db9e8f0e2ae9c40bc1e2b64352a6b4', 'Slider'],
  ['2a4db7a114972834c8e4117be1d82ba3', 'Scrollbar'],
  ['1aa08ab6e0800fa44ae55d278d1423e3', 'ScrollRect'],
  ['d199490a83bb2b844b9695cbf13b01ef', 'InputField'],
  ['0d0b652f32a2cc243917e4028fa0aeb6', 'Dropdown'],
  ['31a19414c41e5ae4aae2af33fee712f6', 'Mask'],
  ['3312d7739989d2b4e91e6319e9a96d76', 'RectMask2D'],
  ['0cd44c1031e13a943bb63640046fad76', 'CanvasScaler'],
  ['dc42784cf147c0c48a680349fa168899', 'GraphicRaycaster'],
  ['3245ec927659c4140ac4f8d17403cc18', 'ContentSizeFitter'],
  ['59f8146938fff824cb5fd77236b75775', 'VerticalLayoutGroup'],
  ['30649d3a9faa99c48a7b1166b86bf2a0', 'HorizontalLayoutGroup'],
  ['306cc8c2b49d7114eaa3623786fc2126', 'LayoutElement'],
  ['e19747de3f5aca642ab2be37e372fb86', 'Outline'],
  ['cfabb0440166ab443bba8876756fdfa9', 'Shadow'],
  // EventSystem（com.unity.ugui）・Input System
  ['76c392e42b5098c458856cdf6ecaaaa1', 'EventSystem'],
  ['4f231c4fb786f3946a6b90b886c48677', 'StandaloneInputModule'],
  ['01614664b831546d2ae94a42149d80ac', 'InputSystemUIInputModule'],
  // TextMeshPro（com.unity.textmeshpro。Unity 6 では com.unity.ugui に同じ guid のまま統合）
  ['f4688fdb7df04437aeb418b961361dc5', 'TextMeshProUGUI'],
  ['9541d86e2fd84c1d9990edf0852d74ab', 'TextMeshPro'],
  ['2da0c512f12947e489f739169773d7ca', 'TMP_InputField'],
  ['7b743370ac3e4ec2a1668f5455a8ef8a', 'TMP_Dropdown'],
]);
