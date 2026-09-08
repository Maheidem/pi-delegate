#!/usr/bin/env python3
"""Render a block of ANSI (SGR) terminal text to a PNG using Menlo.
Proof-of-concept for delegate UI visual evidence. Supports reset/bold and
16/256/truecolor fg+bg. Reads ANSI text from argv[1] (string) or --file,
writes PNG to argv[2]. Dark background like a real terminal."""
import sys, re
from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Menlo.ttc"
SIZE = 18
CELL_H = int(SIZE * 1.35)
BG_DEFAULT = (30, 30, 30)

def xterm256(i):
    if i < 16:
        base = [(0,0,0),(170,0,0),(0,170,0),(170,85,0),(0,0,170),(170,0,170),(0,170,170),(200,200,200),
                (85,85,85),(255,85,85),(85,255,85),(255,255,85),(85,85,255),(255,85,255),(85,255,255),(255,255,255)]
        return base[i]
    if 16 <= i < 232:
        i -= 16; r=(i//36)*51; g=((i//6)%6)*51; b=(i%6)*51; return (r,g,b)
    v=(i-232)*10+8; return (v,v,v)

SGR = re.compile(r"\x1b\[([0-9;]*)m")
# OSC sequences (e.g. tmux's OSC 8 hyperlinks) are markup, not visible text:
# strip them before width measurement and drawing, otherwise the literal URL is
# painted into the cells and the frame overflows its own border.
OSC = re.compile(r"\x1b\][^\x07]*?(?:\x07|\x1b\\)")

def render(text, out):
    font = ImageFont.truetype(FONT, SIZE)
    cell_w = int(font.getlength("M")) or SIZE
    text = OSC.sub("", text)
    lines = text.rstrip("\n").split("\n")
    cols = max((len(re.sub(r"\x1b\[[0-9;]*m","",l)) for l in lines), default=1)
    img = Image.new("RGB", (cols*cell_w+16, len(lines)*CELL_H+16), BG_DEFAULT)
    d = ImageDraw.Draw(img)
    for ry, line in enumerate(lines):
        x = 8; fg=(220,220,220); bg=None; bold=False; pos=0
        for m in SGR.finditer(line):
            for chunk in line[pos:m.start()]:
                if bg: d.rectangle([x, 8+ry*CELL_H, x+cell_w, 8+(ry+1)*CELL_H], fill=bg)
                d.text((x, 8+ry*CELL_H), chunk, font=font, fill=fg)
                x += cell_w
            codes = [int(c) if c else 0 for c in m.group(1).split(";")] if m.group(1) else [0]
            k=0
            while k < len(codes):
                c=codes[k]
                if c==0: fg=(220,220,220); bg=None; bold=False
                elif c==1: bold=True
                elif 30<=c<=37: fg=xterm256(c-30)
                elif 90<=c<=97: fg=xterm256(c-82)
                elif 40<=c<=47: bg=xterm256(c-40)
                elif 100<=c<=107: bg=xterm256(c-92)
                elif c==38 and codes[k+1]==5: fg=xterm256(codes[k+2]); k+=2
                elif c==48 and codes[k+1]==5: bg=xterm256(codes[k+2]); k+=2
                elif c==38 and codes[k+1]==2: fg=tuple(codes[k+2:k+5]); k+=4
                elif c==48 and codes[k+1]==2: bg=tuple(codes[k+2:k+5]); k+=4
                k+=1
            pos=m.end()
        for chunk in line[pos:]:
            if bg: d.rectangle([x, 8+ry*CELL_H, x+cell_w, 8+(ry+1)*CELL_H], fill=bg)
            d.text((x, 8+ry*CELL_H), chunk, font=font, fill=fg)
            x += cell_w
    img.save(out); return img.size

if __name__ == "__main__":
    if sys.argv[1] == "--file": text=open(sys.argv[2]).read(); out=sys.argv[3]
    else: text=sys.argv[1]; out=sys.argv[2]
    print(render(text, out))
