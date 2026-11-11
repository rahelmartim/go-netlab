package main

import (
	"fmt"
	"net"
	"os"
)

var clientsConnected map[string]*net.UDPAddr
var globalNext int

func ErrorHandle(err error) {
	if err != nil {
		fmt.Println("We have a error: ", err)
		fmt.Println("Exitting")
		os.Exit(0)
	}
}

func PrintErrorIfExists(err error) {
	if err != nil {
		fmt.Println("We have a error: ", err)
	}
}

func MapContainsKey(ToCheckKey string, collection map[string]*net.UDPAddr) bool {
	for key, _ := range collection {
		//fmt.Println("COMPARE key")
		//fmt.Println(ToCheckKey)
		//fmt.Println(key)
		if ToCheckKey == key {
			//fmt.Println("true")
			return true
		}
	}
	//fmt.Println("false")
	return false
}

func MapContainsValue(ToCheckValue *net.UDPAddr, collection map[string]*net.UDPAddr) bool {
	for _, value := range collection {
		//fmt.Println("COMPARE value")
		//fmt.Println(ToCheckValue.String())
		//fmt.Println(value.String())
		if value.String() == ToCheckValue.String() {
			//fmt.Println("true")
			return true
		}
	}
	//fmt.Println("false")
	return false
}

func GetKeyFromValue(ToCheckValue *net.UDPAddr, collection map[string]*net.UDPAddr) string {
	returne := ""
	for key, value := range collection {
		if value.String() == ToCheckValue.String() {
			returne = key
		}
	}
	return returne
}

func main() {
	/*Initializing var's*/
	globalNext = 0
	clientsConnected = make(map[string]*net.UDPAddr)

	/*UDP server*/
	fmt.Println("Server Initiated...")
	ServerAddr, err := net.ResolveUDPAddr("udp", ":10001")
	ErrorHandle(err)
	fmt.Println("Address solved...")
	ServerConn, err := net.ListenUDP("udp", ServerAddr)
	ErrorHandle(err)
	fmt.Println("Server Working...")

	/*Defer close UDP connection*/
	defer ServerConn.Close()
	defer fmt.Println("Exiting")

	/*Receive msg's*/
	buf := make([]byte, 1024)
	fmt.Println("Waiting Mensages...")
	for {
		/*Listen msg's*/
		n, addr, err := ServerConn.ReadFromUDP(buf)
		PrintErrorIfExists(err)
		msg := string(buf[0:n])

		/*New Client*/
		if !MapContainsValue(addr, clientsConnected) {
			if !MapContainsKey(msg, clientsConnected) {
				clientsConnected[msg] = addr
				fmt.Println("Connected client: ", msg)
				messageBack := []byte("SUCCESS")
				_, err = ServerConn.WriteToUDP(messageBack, addr)
				continue
			}
		}
		/*Who send*/
		nick := GetKeyFromValue(addr, clientsConnected)
		fmt.Println("Received ", msg, " from ", nick+">"+addr.String())
		fmt.Println("Sending Response to all")

		/*Sending for ALL*/
		for _, adrr := range clientsConnected {
			//do not send it to yourself
			if adrr.String() == addr.String() {
				continue
			}
			messageBack := []byte("[" + nick + "]: " + msg)
			_, err = ServerConn.WriteToUDP(messageBack, adrr)
			PrintErrorIfExists(err)
		}

	}
}
