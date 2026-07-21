package cc.drifting.securestorage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureStorageInstrumentedTest {
    @Test
    fun valueIsEncryptedPersistedAndDeleted() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val key = "test.${UUID.randomUUID()}"
        val value = "secret-${UUID.randomUUID()}"
        val first = SecureStorageBackend(context)

        try {
            assertNull(first.get(key))
            first.set(key, value)

            val stored = first.storageFile(key).readBytes()
            assertFalse(
                stored.toString(StandardCharsets.UTF_8).contains(value),
            )

            // A fresh backend instance exercises durable lookup rather than an
            // in-memory cache. A process/device test can additionally verify an
            // actual application restart.
            val second = SecureStorageBackend(context)
            assertEquals(value, second.get(key))

            val baseFile = second.storageFile(key)
            val legacyBackup = File("${baseFile.path}.bak")
            assertFalse(legacyBackup.exists())
            check(baseFile.renameTo(legacyBackup))
            assertEquals(value, SecureStorageBackend(context).get(key))

            second.delete(key)
            assertNull(second.get(key))
            assertFalse(baseFile.exists())
            assertFalse(File("${baseFile.path}.new").exists())
            assertFalse(legacyBackup.exists())
        } finally {
            first.delete(key)
        }
    }
}
