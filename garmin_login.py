#!/usr/bin/env python3
"""
AeroStride Garmin Connect Interactive Login Helper
Performs the secure login handshake with Multi-Factor Authentication (MFA/OTP),
and saves the session tokens locally to bypass future MFA checks.
"""

import os
import sys
from garminconnect import Garmin

def main():
    print("\n" + "="*55)
    print("   AeroStride Garmin Connect Interactive MFA Setup")
    print("="*55)
    print("Since your Garmin account has Multi-Factor Authentication (OTP/MFA)")
    print("permanently enabled, this helper runs once in your terminal to")
    print("establish the authenticated session and save your secure tokens.")
    print("-"*55)
    
    email = input("Enter Garmin Connect Email: ").strip()
    if not email:
        print("Email is required.")
        return
        
    password = input("Enter Garmin Connect Password: ").strip()
    if not password:
        print("Password is required.")
        return
        
    token_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".garmin-tokens")
    
    # Create directory if it doesn't exist
    os.makedirs(token_dir, exist_ok=True)
    
    print("\n[1/3] Connecting to Garmin SSO Portal...")
    
    def prompt_mfa_callback():
        print("\n" + "*"*45)
        otp = input("👉 [Garmin Security] Enter OTP / MFA Code sent to your device: ").strip()
        print("*"*45)
        return otp
        
    try:
        # Initialize client with the MFA prompt callback
        client = Garmin(email, password, prompt_mfa=prompt_mfa_callback)
        
        print("[2/3] Performing login handshake...")
        client.login()
        
        print("\n[3/3] Session verified! Saving secure tokens locally...")
        client.garth.dump(token_dir)
        
        print("\n" + "="*55)
        print("🎉 [SUCCESS] Garmin Connect Session Established!")
        print("="*55)
        print(f"Secure session tokens have been saved locally to:")
        print(f"  {token_dir}")
        print("\nTo launch your AeroStride server and automatically bypass OTP:")
        print("Run this command in your terminal:")
        print(f'  export GARMINTOKENS="{token_dir}" && python3 server.py')
        print("="*55 + "\n")
        
    except Exception as e:
        print(f"\n❌ [ERROR] Login failed: {e}")
        print("Please verify your email/password and try running this helper again.\n")

if __name__ == "__main__":
    main()
