package cc.drifting.client

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

class MainActivity : TauriActivity() {
  private var keyboardLayoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val root = window.decorView
    var lastKeyboardHeightCssPx = -1f
    var lastKeyboardVisible: Boolean? = null
    val listener = ViewTreeObserver.OnGlobalLayoutListener {
      val rootInsets = ViewCompat.getRootWindowInsets(root) ?: return@OnGlobalLayoutListener
      val visible = rootInsets.isVisible(WindowInsetsCompat.Type.ime())
      val density = root.resources.displayMetrics.density.coerceAtLeast(1f)
      val heightCssPx = if (visible) {
        rootInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom / density
      } else {
        0f
      }
      if (heightCssPx == lastKeyboardHeightCssPx && visible == lastKeyboardVisible) {
        return@OnGlobalLayoutListener
      }
      lastKeyboardHeightCssPx = heightCssPx
      lastKeyboardVisible = visible
      emitKeyboardGeometry(root, heightCssPx, visible)
    }
    keyboardLayoutListener = listener
    root.viewTreeObserver.addOnGlobalLayoutListener(listener)
    root.post { listener.onGlobalLayout() }
  }

  override fun onDestroy() {
    keyboardLayoutListener?.let { listener ->
      val observer = window.decorView.viewTreeObserver
      if (observer.isAlive) observer.removeOnGlobalLayoutListener(listener)
    }
    keyboardLayoutListener = null
    super.onDestroy()
  }

  private fun emitKeyboardGeometry(root: View, heightCssPx: Float, visible: Boolean) {
    val webView = findWebView(root) ?: return
    val height = String.format(Locale.US, "%.3f", heightCssPx.coerceAtLeast(0f))
    val javascript = """
      (() => {
        const height = $height;
        const visible = $visible;
        document.documentElement.style.setProperty('--mobile-native-keyboard-inset', `${'$'}{height}px`);
        window.dispatchEvent(new CustomEvent('drifting:native-keyboard-geometry', {
          detail: { height, visible }
        }));
      })();
    """.trimIndent()
    webView.post { webView.evaluateJavascript(javascript, null) }
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      findWebView(view.getChildAt(index))?.let { return it }
    }
    return null
  }
}
