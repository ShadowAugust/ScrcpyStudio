package com.genymobile.scrcpy.studio;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;

import java.io.InputStream;
import java.io.OutputStream;

/**
 * Scrcpy Studio "phone as speakers": plays raw PCM (48 kHz, s16le, stereo) received
 * from the PC on the phone's speakers.
 *
 * Usage: CLASSPATH=... app_process / com.genymobile.scrcpy.studio.Speaker <socket name>
 *
 * The PC connects through "adb forward tcp:N localabstract:<socket name>". As with the
 * scrcpy server, one dummy byte is sent once the connection is really accepted.
 * The process exits when the PC disconnects.
 */
public final class Speaker {

    private static final int RATE = 48000;
    private static final int FRAME = 4; // stereo s16
    private static final int MAX_BACKLOG = RATE * FRAME * 150 / 1000; // drop audio queued for more than 150 ms
    private static final int KEEP_BACKLOG = RATE * FRAME * 30 / 1000;
    private static final long IDLE_PAUSE_MS = 3000;

    private Speaker() {
    }

    public static void main(String... args) throws Exception {
        String name = args.length > 0 ? args[0] : "studio_speaker";
        AudioTrack track = createTrack();
        if (Build.VERSION.SDK_INT >= 24) {
            // Small playback queue: blocking writes then keep the latency around 50 ms.
            track.setBufferSizeInFrames(Math.max(RATE * 50 / 1000, Math.min(track.getBufferSizeInFrames(), RATE * 50 / 1000)));
        }
        System.out.println("studio-speaker: ready rate=" + RATE + " channels=2 buffer=" + track.getBufferSizeInFrames() + "/" + track.getBufferCapacityInFrames());

        LocalServerSocket server = new LocalServerSocket(name);
        LocalSocket socket = server.accept();
        server.close();
        InputStream in = socket.getInputStream();
        OutputStream out = socket.getOutputStream();
        out.write(0);
        out.flush();
        System.out.println("studio-speaker: connected");

        byte[] buf = new byte[RATE * FRAME / 50]; // 20 ms
        int carry = 0; // keep writes frame-aligned
        boolean playing = false;
        long lastData = System.currentTimeMillis();
        long dropped = 0;
        try {
            for (;;) {
                int avail = in.available();
                if (avail > MAX_BACKLOG) {
                    // Clock drift or a hiccup: catch up instead of accumulating latency.
                    long skip = (avail - KEEP_BACKLOG) / FRAME * FRAME;
                    while (skip > 0) {
                        long s = in.skip(skip);
                        if (s <= 0) {
                            break;
                        }
                        skip -= s;
                        dropped += s;
                    }
                }
                int n = in.read(buf, carry, buf.length - carry);
                if (n < 0) {
                    break;
                }
                n += carry;
                int aligned = n / FRAME * FRAME;
                carry = n - aligned;
                if (aligned > 0) {
                    if (!playing) {
                        track.play();
                        playing = true;
                    }
                    track.write(buf, 0, aligned);
                    lastData = System.currentTimeMillis();
                }
                if (carry > 0) {
                    System.arraycopy(buf, aligned, buf, 0, carry);
                }
                if (playing && in.available() == 0 && System.currentTimeMillis() - lastData > IDLE_PAUSE_MS) {
                    track.pause(); // let the audio output go to standby while the PC is silent
                    playing = false;
                }
            }
        } finally {
            System.out.println("studio-speaker: stopped (dropped " + dropped / FRAME + " frames)");
            try {
                track.stop();
            } catch (IllegalStateException e) {
                // not playing
            }
            track.release();
            socket.close();
        }
        System.exit(0);
    }

    private static AudioTrack createTrack() {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                .build();
        int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        int size = Math.max(min * 2, RATE * FRAME * 120 / 1000);
        AudioTrack.Builder b = new AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(size)
                .setTransferMode(AudioTrack.MODE_STREAM);
        if (Build.VERSION.SDK_INT >= 26) {
            b.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
        }
        return b.build();
    }
}
