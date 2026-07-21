package cc.drifting.securestorage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class SecureStorageBackend(context: Context) {
    private val applicationContext = context.applicationContext
    private val storageDirectory = File(applicationContext.noBackupFilesDir, STORAGE_DIRECTORY)
    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
    }

    @Synchronized
    fun get(key: String): String? {
        validateKey(key)
        val file = storageFile(key)
        val encoded = try {
            readAtomically(file)
        } catch (error: FileNotFoundException) {
            if (storageArtifacts(file).none(File::exists)) return null
            throw error
        }
        val payload = try {
            SecureStorageFormat.decode(encoded)
        } finally {
            encoded.fill(0)
        }
        val plaintext = try {
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                existingMasterKey(),
                GCMParameterSpec(GCM_TAG_LENGTH_BITS, payload.iv),
            )
            cipher.updateAAD(SecureStorageFormat.associatedData(key))
            cipher.doFinal(payload.ciphertext)
        } finally {
            payload.iv.fill(0)
            payload.ciphertext.fill(0)
        }

        return try {
            plaintext.toString(StandardCharsets.UTF_8)
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    fun set(key: String, value: String) {
        validateKey(key)
        val plaintext = value.toByteArray(StandardCharsets.UTF_8)
        require(plaintext.size <= SecureStorageFormat.MAX_PLAINTEXT_BYTES) {
            "secure-storage value is too large"
        }

        val payload = try {
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateMasterKey())
            cipher.updateAAD(SecureStorageFormat.associatedData(key))
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext)
            try {
                SecureStorageFormat.encode(iv, ciphertext)
            } finally {
                iv.fill(0)
                ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }

        try {
            ensureStorageDirectory()
            writeAtomically(storageFile(key), payload)
        } finally {
            payload.fill(0)
        }
    }

    @Synchronized
    fun delete(key: String) {
        validateKey(key)
        val file = storageFile(key)
        AtomicFile(file).delete()
        check(storageArtifacts(file).none(File::exists)) {
            "secure-storage entry could not be deleted"
        }
    }

    internal fun storageFile(key: String): File =
        File(storageDirectory, SecureStorageFormat.storageName(key))

    private fun ensureStorageDirectory() {
        if (!storageDirectory.exists() && !storageDirectory.mkdirs()) {
            throw IllegalStateException("secure-storage directory could not be created")
        }
        require(storageDirectory.isDirectory) {
            "secure-storage path is not a directory"
        }
    }

    private fun writeAtomically(file: File, payload: ByteArray) {
        val atomicFile = AtomicFile(file)
        val output: FileOutputStream = atomicFile.startWrite()
        try {
            output.write(payload)
            output.flush()
            output.fd.sync()
            atomicFile.finishWrite(output)
        } catch (error: Exception) {
            atomicFile.failWrite(output)
            throw error
        }

        val persisted = readAtomically(file)
        try {
            check(MessageDigest.isEqual(payload, persisted)) {
                "secure-storage entry could not be committed"
            }
        } finally {
            persisted.fill(0)
        }
    }

    private fun readAtomically(file: File): ByteArray =
        AtomicFile(file).openRead().use(SecureStorageFormat::readBounded)

    private fun storageArtifacts(file: File): List<File> =
        listOf(file, File("${file.path}.new"), File("${file.path}.bak"))

    private fun existingMasterKey(): SecretKey {
        val key = keyStore.getKey(MASTER_KEY_ALIAS, null)
            ?: throw IllegalStateException("secure-storage master key is missing")
        return key as? SecretKey
            ?: throw IllegalStateException("secure-storage master key has an invalid type")
    }

    private fun getOrCreateMasterKey(): SecretKey {
        (keyStore.getKey(MASTER_KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER,
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                MASTER_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private fun validateKey(key: String) {
        require(KEY_PATTERN.matches(key)) { "invalid secure-storage key" }
        require(key.toByteArray(StandardCharsets.UTF_8).size <= MAX_KEY_BYTES) {
            "invalid secure-storage key"
        }
    }

    private companion object {
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_LENGTH_BITS = 128
        const val MASTER_KEY_ALIAS = "cc.drifting.client.secure-storage.master.v1"
        const val STORAGE_DIRECTORY = "secure-storage-v1"
        const val MAX_KEY_BYTES = 128
        val KEY_PATTERN = Regex("^[A-Za-z0-9._:-]+$")
    }
}
