package cc.drifting.securestorage

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class KeyArgs {
    lateinit var key: String
}

@InvokeArg
class SetArgs {
    lateinit var key: String
    lateinit var value: String
}

@TauriPlugin
class SecureStoragePlugin(activity: Activity) : Plugin(activity) {
    private val storage = SecureStorageBackend(activity)

    @Command
    fun get(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeyArgs::class.java)
            val response = JSObject()
            response.put("value", storage.get(args.key) ?: JSONObject.NULL)
            invoke.resolve(response)
        } catch (_: Exception) {
            invoke.reject("secure storage read failed", "SECURE_STORAGE_READ_FAILED")
        }
    }

    @Command
    fun set(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SetArgs::class.java)
            storage.set(args.key, args.value)
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("secure storage write failed", "SECURE_STORAGE_WRITE_FAILED")
        }
    }

    @Command
    fun delete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeyArgs::class.java)
            storage.delete(args.key)
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("secure storage delete failed", "SECURE_STORAGE_DELETE_FAILED")
        }
    }
}
