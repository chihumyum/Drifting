package cc.drifting.securestorage

import java.io.ByteArrayInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SecureStorageFormatTest {
    @Test
    fun payloadRoundTrips() {
        val iv = ByteArray(12) { it.toByte() }
        val ciphertext = ByteArray(32) { (it + 16).toByte() }

        val decoded = SecureStorageFormat.decode(
            SecureStorageFormat.encode(iv, ciphertext)
        )

        assertArrayEquals(iv, decoded.iv)
        assertArrayEquals(ciphertext, decoded.ciphertext)
    }

    @Test
    fun corruptMagicIsRejected() {
        val payload = SecureStorageFormat.encode(ByteArray(12), ByteArray(16))
        payload[0] = 0

        assertThrows(IllegalArgumentException::class.java) {
            SecureStorageFormat.decode(payload)
        }
    }

    @Test
    fun invalidIvLengthIsRejected() {
        val payload = SecureStorageFormat.encode(ByteArray(12), ByteArray(16))
        payload[4] = 8

        assertThrows(IllegalArgumentException::class.java) {
            SecureStorageFormat.decode(payload)
        }
    }

    @Test
    fun storageNameIsStableAndDoesNotExposeTheLogicalKey() {
        val key = "auth.session-token"
        val name = SecureStorageFormat.storageName(key)

        assertEquals(name, SecureStorageFormat.storageName(key))
        assertFalse(name.contains(key))
        assertEquals(68, name.length)
    }

    @Test
    fun associatedDataBindsCiphertextToItsLogicalKey() {
        assertNotEquals(
            SecureStorageFormat.associatedData("first").toList(),
            SecureStorageFormat.associatedData("second").toList(),
        )
    }

    @Test
    fun boundedReadRejectsOversizedPayloads() {
        val oversized = ByteArray(SecureStorageFormat.MAX_PAYLOAD_BYTES + 1)

        assertThrows(IllegalArgumentException::class.java) {
            ByteArrayInputStream(oversized).use(SecureStorageFormat::readBounded)
        }
    }
}
