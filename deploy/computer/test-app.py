#!/usr/bin/env python3
# PasaBot computer-use test app (W16 Docker proof): one window at the top-left corner of the agent's display that is
# a single 400x200 button. Pressing it prints "pressed" and exits 0. Runs on $DISPLAY (the agent's Xvfb display).
import tkinter as tk

root = tk.Tk()
root.title("PasaBot test app")
root.geometry("400x200+0+0")


def press():
    print("pressed", flush=True)
    root.destroy()


tk.Button(root, text="Press me", command=press).pack(fill="both", expand=True)
root.mainloop()
