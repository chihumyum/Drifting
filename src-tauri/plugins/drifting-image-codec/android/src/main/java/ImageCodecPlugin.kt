package cc.drifting.imagecodec

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

@InvokeArg
class PrepareImageArgs {
    lateinit var filePath: String
    lateinit var codec: String
    var displayMaxLongEdge: Int = 1600
    var displayQuality: Int = 82
    var thumbnailMaxLongEdge: Int = 512
    var thumbnailQuality: Int = 72
    var maxDimension: Int = 16384
    var maxDecodedBytes: Long = 256L * 1024L * 1024L
}

private data class DecodedVariant(
    val bitmap: Bitmap,
    val sourceWidth: Int,
    val sourceHeight: Int,
)

@TauriPlugin
class ImageCodecPlugin(activity: Activity) : Plugin(activity) {
    private val cacheDirectory = activity.cacheDir

    @Command
    fun prepareImage(invoke: Invoke) {
        Thread {
            var displayFile: File? = null
            var thumbnailFile: File? = null
            var decoded: DecodedVariant? = null
            try {
                val args = invoke.parseArgs(PrepareImageArgs::class.java)
                ensureCodecAvailable(args.codec)
                val source = File(args.filePath)
                if (!source.isFile) throw IllegalArgumentException("image source is not a file")

                val prepared = decodeVariant(
                    source,
                    max(args.displayMaxLongEdge, args.thumbnailMaxLongEdge),
                    args,
                )
                decoded = prepared
                validateDimensions(prepared.sourceWidth, prepared.sourceHeight, args)
                displayFile = File.createTempFile("drifting-display-", ".jpg", cacheDirectory)
                val displaySize = writeVariant(
                    prepared.bitmap,
                    displayFile,
                    args.displayMaxLongEdge,
                    args.displayQuality,
                )
                thumbnailFile = File.createTempFile("drifting-thumbnail-", ".jpg", cacheDirectory)
                val thumbnailSize = writeVariant(
                    prepared.bitmap,
                    thumbnailFile,
                    args.thumbnailMaxLongEdge,
                    args.thumbnailQuality,
                )

                val response = JSObject()
                response.put("width", prepared.sourceWidth)
                response.put("height", prepared.sourceHeight)
                response.put("displayPath", displayFile.absolutePath)
                response.put("displayWidth", displaySize.first)
                response.put("displayHeight", displaySize.second)
                response.put("thumbnailPath", thumbnailFile.absolutePath)
                response.put("thumbnailWidth", thumbnailSize.first)
                response.put("thumbnailHeight", thumbnailSize.second)
                invoke.resolve(response)
            } catch (error: CodecUnavailableException) {
                displayFile?.delete()
                thumbnailFile?.delete()
                invoke.reject(error.message ?: "system image codec is unavailable", "IMAGE_CODEC_UNAVAILABLE")
            } catch (_: Exception) {
                displayFile?.delete()
                thumbnailFile?.delete()
                invoke.reject("native image decode failed", "IMAGE_INVALID")
            } finally {
                decoded?.bitmap?.recycle()
            }
        }.start()
    }

    private fun ensureCodecAvailable(codec: String) {
        val normalized = codec.lowercase()
        when (normalized) {
            "heic", "heif" -> if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                throw CodecUnavailableException("HEIC/HEIF requires Android 8 or newer")
            }
            "avif" -> if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                throw CodecUnavailableException("AVIF requires Android 12 or newer")
            }
            else -> throw IllegalArgumentException("unsupported native image codec")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val mimeTypes = when (normalized) {
                "heic", "heif" -> listOf("image/heic", "image/heif")
                "avif" -> listOf("image/avif")
                else -> emptyList()
            }
            if (mimeTypes.none { ImageDecoder.isMimeTypeSupported(it) }) {
                throw CodecUnavailableException("$normalized is not supported by this Android codec")
            }
        }
    }

    private fun validateDimensions(width: Int, height: Int, args: PrepareImageArgs) {
        if (width <= 0 || height <= 0 || width > args.maxDimension || height > args.maxDimension) {
            throw IllegalArgumentException("image dimensions exceed the supported limit")
        }
        val decodedBytes = width.toLong() * height.toLong() * 4L
        if (decodedBytes > args.maxDecodedBytes) {
            throw IllegalArgumentException("decoded image exceeds the allocation limit")
        }
    }

    private fun targetDimensions(width: Int, height: Int, maxLongEdge: Int): Pair<Int, Int> {
        val longest = max(width, height)
        if (longest <= maxLongEdge) return Pair(width, height)
        val scale = maxLongEdge.toDouble() / longest.toDouble()
        return Pair(
            (width * scale).roundToInt().coerceAtLeast(1),
            (height * scale).roundToInt().coerceAtLeast(1),
        )
    }

    private fun decodeVariant(
        source: File,
        maxLongEdge: Int,
        args: PrepareImageArgs,
    ): DecodedVariant {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            decodeWithImageDecoder(source, maxLongEdge, args)
        } else {
            decodeWithBitmapFactory(source, maxLongEdge, args)
        }
    }

    private fun decodeWithImageDecoder(
        source: File,
        maxLongEdge: Int,
        args: PrepareImageArgs,
    ): DecodedVariant {
        var sourceWidth = 0
        var sourceHeight = 0
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(source)) { decoder, info, _ ->
            sourceWidth = info.size.width
            sourceHeight = info.size.height
            validateDimensions(sourceWidth, sourceHeight, args)
            val (targetWidth, targetHeight) = targetDimensions(
                sourceWidth,
                sourceHeight,
                maxLongEdge,
            )
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setTargetSize(targetWidth, targetHeight)
        }
        return DecodedVariant(bitmap, sourceWidth, sourceHeight)
    }

    private fun decodeWithBitmapFactory(
        source: File,
        maxLongEdge: Int,
        args: PrepareImageArgs,
    ): DecodedVariant {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        val sourceWidth = bounds.outWidth
        val sourceHeight = bounds.outHeight
        validateDimensions(sourceWidth, sourceHeight, args)
        val (targetWidth, targetHeight) = targetDimensions(sourceWidth, sourceHeight, maxLongEdge)

        var sampleSize = 1
        while (
            sourceWidth / (sampleSize * 2) >= targetWidth &&
            sourceHeight / (sampleSize * 2) >= targetHeight
        ) {
            sampleSize *= 2
        }
        val decoded = BitmapFactory.decodeFile(
            source.absolutePath,
            BitmapFactory.Options().apply { inSampleSize = sampleSize },
        ) ?: throw IllegalArgumentException("native image decode failed")
        val scaled = if (decoded.width == targetWidth && decoded.height == targetHeight) {
            decoded
        } else {
            Bitmap.createScaledBitmap(decoded, targetWidth, targetHeight, true).also {
                decoded.recycle()
            }
        }
        return DecodedVariant(scaled, sourceWidth, sourceHeight)
    }

    private fun writeVariant(
        bitmap: Bitmap,
        file: File,
        maxLongEdge: Int,
        quality: Int,
    ): Pair<Int, Int> {
        val (width, height) = targetDimensions(bitmap.width, bitmap.height, maxLongEdge)
        val variant = if (width == bitmap.width && height == bitmap.height) {
            bitmap
        } else {
            Bitmap.createScaledBitmap(bitmap, width, height, true)
        }
        try {
            writeJpeg(variant, file, quality)
        } finally {
            if (variant !== bitmap) variant.recycle()
        }
        return Pair(width, height)
    }

    private fun writeJpeg(bitmap: Bitmap, file: File, quality: Int) {
        val flattened = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
        try {
            Canvas(flattened).apply {
                drawColor(Color.WHITE)
                drawBitmap(bitmap, 0f, 0f, null)
            }
            FileOutputStream(file).use { output ->
                if (!flattened.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), output)) {
                    throw IllegalArgumentException("native JPEG encode failed")
                }
                output.fd.sync()
            }
        } finally {
            flattened.recycle()
        }
    }
}

private class CodecUnavailableException(message: String) : Exception(message)
