package cc.drifting.securestorage

import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal data class EncryptedPayload(
    val iv: ByteArray,
    val ciphertext: ByteArray,
)

internal object SecureStorageFormat {
    private val MAGIC = byteArrayOf(0x44, 0x53, 0x4b, 0x31) // DSK1
    private const val IV_LENGTH = 12
    private const val GCM_TAG_LENGTH_BYTES = 16
    const val MAX_PLAINTEXT_BYTES = 256 * 1024
    const val MAX_PAYLOAD_BYTES = MAX_PLAINTEXT_BYTES + 64

    fun encode(iv: ByteArray, ciphertext: ByteArray): ByteArray {
        require(iv.size == IV_LENGTH) { "invalid secure-storage IV" }
        require(ciphertext.size >= GCM_TAG_LENGTH_BYTES) {
            "invalid secure-storage ciphertext"
        }
        require(MAGIC.size + 1 + iv.size + ciphertext.size <= MAX_PAYLOAD_BYTES) {
            "secure-storage payload is too large"
        }

        return ByteArray(MAGIC.size + 1 + iv.size + ciphertext.size).also { output ->
            MAGIC.copyInto(output, destinationOffset = 0)
            output[MAGIC.size] = iv.size.toByte()
            iv.copyInto(output, destinationOffset = MAGIC.size + 1)
            ciphertext.copyInto(output, destinationOffset = MAGIC.size + 1 + iv.size)
        }
    }

    fun decode(payload: ByteArray): EncryptedPayload {
        require(payload.size <= MAX_PAYLOAD_BYTES) { "secure-storage payload is too large" }
        require(payload.size >= MAGIC.size + 1 + IV_LENGTH + GCM_TAG_LENGTH_BYTES) {
            "secure-storage payload is truncated"
        }
        require(payload.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) {
            "unsupported secure-storage payload version"
        }

        val ivLength = payload[MAGIC.size].toInt() and 0xff
        require(ivLength == IV_LENGTH) { "invalid secure-storage IV" }
        val ciphertextOffset = MAGIC.size + 1 + ivLength
        require(payload.size - ciphertextOffset >= GCM_TAG_LENGTH_BYTES) {
            "secure-storage payload is truncated"
        }

        return EncryptedPayload(
            iv = payload.copyOfRange(MAGIC.size + 1, ciphertextOffset),
            ciphertext = payload.copyOfRange(ciphertextOffset, payload.size),
        )
    }

    fun readBounded(input: InputStream): ByteArray {
        val buffer = ByteArray(MAX_PAYLOAD_BYTES + 1)
        var length = 0
        try {
            while (length < buffer.size) {
                val count = input.read(buffer, length, buffer.size - length)
                if (count < 0) break
                if (count == 0) {
                    val next = input.read()
                    if (next < 0) break
                    buffer[length] = next.toByte()
                    length += 1
                } else {
                    length += count
                }
            }
            require(length <= MAX_PAYLOAD_BYTES) {
                "secure-storage payload is too large"
            }
            return buffer.copyOf(length)
        } finally {
            buffer.fill(0)
        }
    }

    fun storageName(key: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(key.toByteArray(StandardCharsets.UTF_8))
        return digest.joinToString(separator = "") { byte ->
            (byte.toInt() and 0xff).toString(16).padStart(2, '0')
        } + ".bin"
    }

    fun associatedData(key: String): ByteArray =
        "cc.drifting.client.secure-storage.v1\u0000$key"
            .toByteArray(StandardCharsets.UTF_8)
}
